#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as os from "node:os";
import * as readline from "node:readline";

type Args = {
  since?: string;
  from?: string;
  to?: string;
  output: string;
  logsDir: string;
};

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") out.since = argv[++i];
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--output" || a === "-o") out.output = argv[++i];
    else if (a === "--logs-dir") out.logsDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!out.output) {
    out.output = "report.md";
  }
  if (!out.logsDir) {
    const root = process.env.XCACHE_ROOT
      ? expandHome(process.env.XCACHE_ROOT)
      : path.join(os.homedir(), ".openclaw", "xcache-mcp");
    out.logsDir = path.join(root, "logs");
  }
  return out as Args;
}

function printHelp(): void {
  process.stderr.write(
    [
      "xcache-mcp consolidate — summarize JSONL event logs into a Markdown report",
      "",
      "Usage:",
      "  npx xcache-mcp consolidate --since 7d --output report.md",
      "  npx xcache-mcp consolidate --from 2026-04-29 --to 2026-05-05 --output report.md",
      "",
      "Options:",
      "  --since <Nd|Nh>           Window ending now (e.g. 7d, 1d, 24h)",
      "  --from <iso>              Start of window (UTC date or ISO datetime)",
      "  --to <iso>                End of window (UTC date or ISO datetime)",
      "  --output, -o <path>       Output Markdown file (default: report.md)",
      "  --logs-dir <path>         Override logs directory (default: $XCACHE_ROOT/logs)",
      "  --help, -h                Show this help",
      "",
    ].join("\n"),
  );
}

type Window = { fromMs: number; toMs: number; days: number };

function resolveWindow(args: Args): Window {
  const now = Date.now();
  if (args.since) {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec(args.since.trim().toLowerCase());
    if (!m) throw new Error(`invalid --since: ${args.since}`);
    const n = Number(m[1]);
    const u = m[2] as "s" | "m" | "h" | "d";
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u];
    const fromMs = now - n * mult;
    return { fromMs, toMs: now, days: Math.max(1, Math.ceil((now - fromMs) / 86_400_000)) };
  }
  if (args.from) {
    const fromMs = Date.parse(args.from);
    const toMs = args.to ? Date.parse(args.to) : now;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error("invalid --from/--to");
    }
    return { fromMs, toMs, days: Math.max(1, Math.ceil((toMs - fromMs) / 86_400_000)) };
  }
  // Default: last 7 days.
  return {
    fromMs: now - 7 * 86_400_000,
    toMs: now,
    days: 7,
  };
}

function fileDay(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$/.exec(name);
  return m ? (m[1] ?? null) : null;
}

function dayInWindow(day: string, w: Window): boolean {
  const start = Date.parse(day + "T00:00:00.000Z");
  const end = start + 86_400_000;
  return end > w.fromMs && start < w.toMs;
}

type EventRow = {
  ts: string;
  ts_ms: number;
  client_kind: string;
  mcp_tool: string | null;
  endpoint_template: string | null;
  query_fingerprint: string | null;
  requested_fields: string[];
  is_paginated: boolean;
  pagination_chain_id: string | null;
  pagination_depth: number | null;
  operation: string | null;
  account_id: string | null;
  status: number;
  source: string;
  cache_outcome: string;
  duration_ms: number;
  response_bytes: number;
  result_count: number | null;
  rate_limit_limit: number | null;
  rate_limit_remaining: number | null;
  rate_limit_reset: number | null;
};

async function readEvents(logsDir: string, w: Window): Promise<EventRow[]> {
  const dir = path.join(logsDir, "events");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => {
      const day = fileDay(n);
      return day !== null && dayInWindow(day, w);
    });

  const rows: EventRow[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let stream: NodeJS.ReadableStream;
    if (f.endsWith(".gz")) {
      const raw = fs.createReadStream(full);
      stream = raw.pipe(zlib.createGunzip());
    } else {
      stream = fs.createReadStream(full);
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const tsMs = Date.parse(obj.ts ?? "");
      if (!Number.isFinite(tsMs) || tsMs < w.fromMs || tsMs >= w.toMs) continue;
      rows.push({
        ts: obj.ts,
        ts_ms: tsMs,
        client_kind: obj.client_kind ?? "",
        mcp_tool: obj.mcp_tool ?? null,
        endpoint_template: obj.endpoint_template ?? null,
        query_fingerprint: obj.query_fingerprint ?? null,
        requested_fields: Array.isArray(obj.requested_fields) ? obj.requested_fields : [],
        is_paginated: !!obj.is_paginated,
        pagination_chain_id: obj.pagination_chain_id ?? null,
        pagination_depth: typeof obj.pagination_depth === "number" ? obj.pagination_depth : null,
        operation: obj.operation ?? null,
        account_id: obj.account_id ?? null,
        status: typeof obj.status === "number" ? obj.status : 0,
        source: obj.source ?? "",
        cache_outcome: obj.cache_outcome ?? "",
        duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
        response_bytes: typeof obj.response_bytes === "number" ? obj.response_bytes : 0,
        result_count: typeof obj.result_count === "number" ? obj.result_count : null,
        rate_limit_limit: typeof obj.rate_limit_limit === "number" ? obj.rate_limit_limit : null,
        rate_limit_remaining:
          typeof obj.rate_limit_remaining === "number" ? obj.rate_limit_remaining : null,
        rate_limit_reset: typeof obj.rate_limit_reset === "number" ? obj.rate_limit_reset : null,
      });
    }
  }
  return rows;
}

function roundBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}e9`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}e6`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}e3`;
  return String(n);
}

function jsonBlock(label: string, value: unknown): string {
  return `## ${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n`;
}

function pct(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[i] ?? 0;
}

function topN<K, V>(map: Map<K, V>, n: number, score: (v: V) => number): Array<[K, V]> {
  return Array.from(map.entries())
    .sort((a, b) => score(b[1]) - score(a[1]))
    .slice(0, n);
}

type EndpointAgg = {
  upstream: number;
  cache_hits: number;
  gate_blocked: number;
  errors: number;
  total: number;
  bytes: number;
};

type OpAcctAgg = {
  upstream: number;
  ts: number[];
};

type FpAgg = {
  upstream: number;
  endpoint: string | null;
  fields: Map<string, number>;
};

export async function runConsolidate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const w = resolveWindow(args);
  const rows = await readEvents(args.logsDir, w);
  const sections: string[] = [];

  // Window header
  const totals = {
    requests_total: rows.length,
    upstream_calls: rows.filter((r) => r.source === "live" || r.source === "error").length,
    cache_hits: rows.filter((r) => r.cache_outcome === "hit").length,
    gate_blocked: rows.filter((r) => r.source === "gate_blocked").length,
    errors: rows.filter((r) => r.source === "error" || (r.status >= 400 && r.status < 600)).length,
    bytes_total: rows.reduce((a, r) => a + (r.response_bytes || 0), 0),
  };
  const fromIso = new Date(w.fromMs).toISOString().slice(0, 10);
  const toIso = new Date(w.toMs - 1).toISOString().slice(0, 10);

  let report = `# xcache-mcp summary ${fromIso} — ${toIso}\n\n`;

  if (rows.length === 0) {
    report += `## window\n\`\`\`json\n${JSON.stringify({ days: w.days, ...totals }, null, 2)}\n\`\`\`\n\n`;
    report += `(no events in window)\n`;
    fs.writeFileSync(args.output, report);
    process.stderr.write(`[consolidate] wrote ${args.output} (no events in window)\n`);
    return;
  }

  sections.push(jsonBlock("window", { days: w.days, ...totals }));

  // Endpoint table
  const endpointAgg = new Map<string, EndpointAgg>();
  for (const r of rows) {
    const ep = r.endpoint_template ?? "(unknown)";
    const agg = endpointAgg.get(ep) ?? {
      upstream: 0,
      cache_hits: 0,
      gate_blocked: 0,
      errors: 0,
      total: 0,
      bytes: 0,
    };
    agg.total += 1;
    agg.bytes += r.response_bytes;
    if (r.source === "live") agg.upstream += 1;
    else if (r.source === "error") {
      agg.upstream += 1;
      agg.errors += 1;
    }
    if (r.cache_outcome === "hit") agg.cache_hits += 1;
    if (r.source === "gate_blocked") agg.gate_blocked += 1;
    endpointAgg.set(ep, agg);
  }
  const endpointRows = topN(endpointAgg, 10, (v) => v.upstream).map(([ep, v]) => ({
    endpoint: ep,
    upstream: v.upstream,
    bytes: roundBig(v.bytes),
    hit_rate: v.total > 0 ? pct(v.cache_hits / v.total) : 0,
    gate_block_rate: v.total > 0 ? pct(v.gate_blocked / v.total) : 0,
  }));
  if (endpointRows.length > 0) {
    sections.push(jsonBlock("top endpoints by upstream calls", endpointRows));
  }

  // Upstream-call hotspots: operation+account
  const opAcctAgg = new Map<string, OpAcctAgg>();
  for (const r of rows) {
    if (r.source !== "live" && r.source !== "error") continue;
    if (!r.operation || !r.account_id) continue;
    const k = `${r.operation}|${r.account_id}`;
    const a = opAcctAgg.get(k) ?? { upstream: 0, ts: [] };
    a.upstream += 1;
    a.ts.push(r.ts_ms);
    opAcctAgg.set(k, a);
  }
  const hotspots = topN(opAcctAgg, 10, (v) => v.upstream).map(([k, v]) => {
    const [op, acct] = k.split("|");
    const sorted = [...v.ts].sort((a, b) => a - b);
    let medianMin: number | null = null;
    if (sorted.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        deltas.push((sorted[i]! - sorted[i - 1]!) / 60_000);
      }
      deltas.sort((a, b) => a - b);
      medianMin = Math.round((deltas[Math.floor(deltas.length / 2)] ?? 0) * 10) / 10;
    }
    return {
      operation: op,
      account_id: acct,
      upstream_calls: v.upstream,
      median_minutes_between: medianMin,
    };
  });
  if (hotspots.length > 0) {
    sections.push(
      "## upstream-call hotspots\n" +
        "top operation+account pairs that drove the most upstream traffic — useful for deciding which gates to lengthen\n" +
        "```json\n" +
        JSON.stringify(hotspots, null, 2) +
        "\n```\n\n",
    );
  }

  // Redundancy hotspots: same fingerprint with multiple upstream calls
  const fpAgg = new Map<string, FpAgg>();
  for (const r of rows) {
    if (r.source !== "live" && r.source !== "error") continue;
    if (!r.query_fingerprint) continue;
    const a = fpAgg.get(r.query_fingerprint) ?? {
      upstream: 0,
      endpoint: r.endpoint_template ?? null,
      fields: new Map(),
    };
    a.upstream += 1;
    if (!a.endpoint) a.endpoint = r.endpoint_template ?? null;
    const fk = r.requested_fields.slice().sort().join(",");
    a.fields.set(fk, (a.fields.get(fk) ?? 0) + 1);
    fpAgg.set(r.query_fingerprint, a);
  }
  const redundancy = Array.from(fpAgg.entries())
    .filter(([, v]) => v.upstream >= 2)
    .sort((a, b) => b[1].upstream - a[1].upstream)
    .slice(0, 10)
    .map(([fp, v]) => ({
      fingerprint: fp,
      upstream_calls: v.upstream,
      endpoint: v.endpoint,
    }));
  if (redundancy.length > 0) {
    sections.push(
      "## redundancy hotspots\n" +
        "top query fingerprints with multiple upstream calls (would benefit from longer gate; identical requests slipping through current interval)\n" +
        "```json\n" +
        JSON.stringify(redundancy, null, 2) +
        "\n```\n\n",
    );
  }

  // Field-set drift
  const drift: Array<{
    endpoint: string | null;
    fingerprint: string;
    sets_seen: Array<{ fields: string; count: number }>;
  }> = [];
  for (const [fp, v] of fpAgg) {
    if (v.fields.size < 2) continue;
    drift.push({
      endpoint: v.endpoint,
      fingerprint: fp,
      sets_seen: Array.from(v.fields.entries()).map(([fields, count]) => ({ fields, count })),
    });
  }
  drift.sort((a, b) => b.sets_seen.length - a.sets_seen.length);
  if (drift.length > 0) {
    sections.push(
      "## field-set drift\n" +
        "queries with same fingerprint requesting different field/expansion sets — consolidation candidates\n" +
        "```json\n" +
        JSON.stringify(drift.slice(0, 10), null, 2) +
        "\n```\n\n",
    );
  }

  // Pagination depth
  const chainDepths = new Map<string, { endpoint: string | null; max: number }>();
  for (const r of rows) {
    if (!r.is_paginated || !r.pagination_chain_id) continue;
    const c = chainDepths.get(r.pagination_chain_id) ?? {
      endpoint: r.endpoint_template ?? null,
      max: 0,
    };
    if (r.pagination_depth != null && r.pagination_depth > c.max) c.max = r.pagination_depth;
    chainDepths.set(r.pagination_chain_id, c);
  }
  const epPag = new Map<string, number[]>();
  for (const v of chainDepths.values()) {
    const ep = v.endpoint ?? "(unknown)";
    const arr = epPag.get(ep) ?? [];
    arr.push(v.max);
    epPag.set(ep, arr);
  }
  const pagRows = Array.from(epPag.entries())
    .map(([ep, arr]) => {
      arr.sort((a, b) => a - b);
      return {
        endpoint: ep,
        p50: quantile(arr, 0.5),
        p90: quantile(arr, 0.9),
        p99: quantile(arr, 0.99),
        max: arr[arr.length - 1] ?? 0,
      };
    })
    .sort((a, b) => b.max - a.max)
    .slice(0, 10);
  if (pagRows.length > 0) {
    sections.push(jsonBlock("pagination depth", pagRows));
  }

  // Rate-limit incidents
  const rlIncidents: Array<{
    endpoint: string | null;
    window_start: string;
    min_remaining: number;
    limit: number | null;
    calls_in_window: number;
  }> = [];
  // Group by hour and endpoint, find min remaining.
  const rlBuckets = new Map<
    string,
    { ts: number; min: number; limit: number | null; calls: number; endpoint: string | null }
  >();
  for (const r of rows) {
    if (r.rate_limit_remaining == null) continue;
    const hour = Math.floor(r.ts_ms / 3_600_000) * 3_600_000;
    const key = `${r.endpoint_template ?? ""}|${hour}`;
    const b = rlBuckets.get(key) ?? {
      ts: hour,
      min: r.rate_limit_remaining,
      limit: r.rate_limit_limit,
      calls: 0,
      endpoint: r.endpoint_template ?? null,
    };
    if (r.rate_limit_remaining < b.min) b.min = r.rate_limit_remaining;
    b.calls += 1;
    rlBuckets.set(key, b);
  }
  for (const b of rlBuckets.values()) {
    if (b.limit != null && b.min <= b.limit * 0.2) {
      rlIncidents.push({
        endpoint: b.endpoint,
        window_start: new Date(b.ts).toISOString(),
        min_remaining: b.min,
        limit: b.limit,
        calls_in_window: b.calls,
      });
    }
  }
  rlIncidents.sort((a, b) => a.min_remaining - b.min_remaining);
  if (rlIncidents.length > 0) {
    sections.push(jsonBlock("rate-limit incidents", rlIncidents.slice(0, 10)));
  }

  // Errors
  const errors: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (r.status < 400 || r.status >= 600) continue;
    const cls = r.status >= 500 ? "5xx" : "4xx";
    errors[cls] = errors[cls] ?? {};
    errors[cls][String(r.status)] = (errors[cls][String(r.status)] ?? 0) + 1;
  }
  if (Object.keys(errors).length > 0) {
    sections.push(jsonBlock("errors", errors));
  }

  // Hourly time series
  const hourly = new Map<string, { reqs: number; up: number; hits: number; errs: number }>();
  for (const r of rows) {
    const d = new Date(r.ts_ms);
    const hour = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
    const h = hourly.get(hour) ?? { reqs: 0, up: 0, hits: 0, errs: 0 };
    h.reqs += 1;
    if (r.source === "live") h.up += 1;
    if (r.cache_outcome === "hit") h.hits += 1;
    if (r.source === "error" || (r.status >= 400 && r.status < 600)) h.errs += 1;
    hourly.set(hour, h);
  }
  const hourRows = Array.from(hourly.entries())
    .sort()
    .map(([h, v]) => [h, v.reqs, v.up, v.reqs > 0 ? pct(v.hits / v.reqs) : 0, v.errs]);
  if (hourRows.length > 0) {
    sections.push(
      "## hourly time series\nschema: `[hour, requests, upstream, hit_rate, errors]`\n" +
        "```json\n" +
        JSON.stringify(hourRows, null, 2) +
        "\n```\n\n",
    );
  }

  // Raw samples — small selection.
  const samples: Record<string, unknown[]> = {};
  // Sample one per redundancy group (up to 5)
  if (redundancy.length > 0) {
    const out: unknown[] = [];
    for (const r of redundancy.slice(0, 5)) {
      const matching = rows
        .filter(
          (row) =>
            row.query_fingerprint === r.fingerprint &&
            (row.source === "live" || row.source === "error"),
        )
        .sort((a, b) => a.ts_ms - b.ts_ms);
      if (matching.length >= 2) {
        const a = matching[0]!;
        const b = matching[1]!;
        out.push({
          ts: a.ts,
          fp: r.fingerprint,
          interval_seconds: Math.round((b.ts_ms - a.ts_ms) / 1000),
          both_upstream: true,
        });
      }
    }
    if (out.length > 0) samples["redundancy"] = out;
  }
  if (Object.keys(samples).length > 0) {
    let s = "## raw samples\nsmall selection illustrating patterns (cap 5 per category)\n\n";
    for (const [k, arr] of Object.entries(samples)) {
      s += `### ${k}\n\`\`\`json\n${JSON.stringify(arr, null, 2)}\n\`\`\`\n\n`;
    }
    sections.push(s);
  }

  // Processing notes
  sections.push(
    jsonBlock("processing notes", {
      files_read: countLogFiles(args.logsDir, w),
      events_processed: rows.length,
    }),
  );

  report += sections.join("");
  fs.writeFileSync(args.output, report);
  process.stderr.write(`[consolidate] wrote ${args.output} (${rows.length} events)\n`);
}

function countLogFiles(logsDir: string, w: Window): number {
  const dir = path.join(logsDir, "events");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((e) => {
    if (!e.isFile()) return false;
    const day = fileDay(e.name);
    return day !== null && dayInWindow(day, w);
  }).length;
}

// Allow direct CLI execution: `tsx bin/consolidate.ts ...`
const invokedDirectly = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    return arg1.endsWith("consolidate.ts") || arg1.endsWith("consolidate.js");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runConsolidate(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `[consolidate] error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
