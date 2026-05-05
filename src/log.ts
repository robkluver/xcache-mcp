import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { metaIncrement } from "./cache.js";

export type EventLogEntry = {
  ts: string;
  request_id: string;
  client_kind: "mcp_http" | "mcp_stdio" | "rest";
  mcp_tool?: string | null;
  mcp_jsonrpc_id?: string | null;
  agent_session_id?: string | null;
  method: string;
  url: string;
  endpoint_template?: string | null;
  query_fingerprint?: string | null;
  requested_fields: string[];
  is_paginated: boolean;
  pagination_chain_id?: string | null;
  pagination_depth?: number | null;
  operation?: string | null;
  account_id?: string | null;
  status: number;
  source: "live" | "cache" | "gate_blocked" | "error";
  cache_outcome: "hit" | "miss" | "gate_blocked" | "not_cacheable";
  gate_state?: { open: boolean; last_fetched_at: string | null } | null;
  duration_ms: number;
  response_bytes: number;
  result_count?: number | null;
  next_token_present?: boolean | null;
  rate_limit_limit?: number | null;
  rate_limit_remaining?: number | null;
  rate_limit_reset?: number | null;
  error_class?: string | null;
  error_message?: string | null;
  body_truncated?: boolean | null;
  body_ref?: string | null;
};

export type BodyLogEntry = {
  request_id: string;
  body: string;
};

type Queued = { kind: "event"; entry: EventLogEntry } | { kind: "body"; entry: BodyLogEntry };

class BoundedQueue<T> {
  private items: T[] = [];
  constructor(private capacity: number) {}
  push(item: T): "ok" | "dropped" {
    if (this.items.length >= this.capacity) {
      this.items.shift(); // drop oldest
      this.items.push(item);
      return "dropped";
    }
    this.items.push(item);
    return "ok";
  }
  drainAll(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
  size(): number {
    return this.items.length;
  }
}

const QUEUE_CAPACITY = 10_000;
const FLUSH_INTERVAL_MS = 250;

export class LogWriter {
  private queue = new BoundedQueue<Queued>(QUEUE_CAPACITY);
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private logsDir: string,
    private logBodies: boolean,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        // Swallow — failures here must not crash the proxy.
      });
    }, FLUSH_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    // Daily rotation check (gzip files older than 7 days).
    const rotateTimer = setInterval(
      () => {
        try {
          this.rotateOldFiles();
        } catch {
          // ignore
        }
      },
      60 * 60 * 1000,
    );
    if (rotateTimer.unref) rotateTimer.unref();
  }

  enqueueEvent(entry: EventLogEntry): void {
    if (this.stopped) return;
    const r = this.queue.push({ kind: "event", entry });
    if (r === "dropped") {
      try {
        metaIncrement("dropped_log_entries", 1);
      } catch {
        // ignore
      }
    }
  }

  enqueueBody(entry: BodyLogEntry): void {
    if (!this.logBodies) return;
    if (this.stopped) return;
    const r = this.queue.push({ kind: "body", entry });
    if (r === "dropped") {
      try {
        metaIncrement("dropped_log_entries", 1);
      } catch {
        // ignore
      }
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.queue.size() === 0) return;
    this.flushing = true;
    try {
      const items = this.queue.drainAll();
      // Group by file to minimize FD churn.
      const groups = new Map<string, string[]>();
      for (const item of items) {
        const file = this.fileFor(item);
        const line = JSON.stringify(item.entry) + "\n";
        const arr = groups.get(file) ?? [];
        arr.push(line);
        groups.set(file, arr);
      }
      for (const [file, lines] of groups) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          // Open with 0600
          const fd = fs.openSync(file, "a", 0o600);
          try {
            fs.writeSync(fd, lines.join(""));
          } finally {
            fs.closeSync(fd);
          }
          // Ensure mode 0600 even if file existed previously.
          try {
            fs.chmodSync(file, 0o600);
          } catch {
            // ignore
          }
        } catch {
          // Drop this group — no retries to avoid amplifying outages.
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Drain with a deadline. Used on shutdown. */
  async drainWithDeadline(deadlineMs: number): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
      if (this.queue.size() === 0) break;
      await this.flush();
      if (this.queue.size() === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // One final attempt (best effort).
    try {
      await this.flush();
    } catch {
      // ignore
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private fileFor(item: Queued): string {
    const day = todayUtc();
    if (item.kind === "event") {
      return path.join(this.logsDir, "events", `${day}.jsonl`);
    }
    return path.join(this.logsDir, "bodies", `${day}.jsonl`);
  }

  private rotateOldFiles(): void {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const sub of ["events", "bodies"]) {
      const dir = path.join(this.logsDir, sub);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (!ent.name.endsWith(".jsonl")) continue;
        const full = path.join(dir, ent.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.mtimeMs > cutoff) continue;
        // Don't rotate today's file even if mtime is somehow stale.
        const dayStem = ent.name.replace(/\.jsonl$/, "");
        if (dayStem === todayUtc()) continue;
        const gzPath = full + ".gz";
        try {
          const data = fs.readFileSync(full);
          const gz = zlib.gzipSync(data);
          fs.writeFileSync(gzPath, gz, { mode: 0o600 });
          fs.unlinkSync(full);
        } catch {
          // ignore
        }
      }
    }
  }
}

export function todayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let writer: LogWriter | null = null;

export function initLogWriter(logsDir: string, logBodies: boolean): LogWriter {
  if (writer) return writer;
  writer = new LogWriter(logsDir, logBodies);
  writer.start();
  return writer;
}

export function getLogWriter(): LogWriter {
  if (!writer) throw new Error("Log writer not initialized");
  return writer;
}
