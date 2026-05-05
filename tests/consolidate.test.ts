import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { runConsolidate } from "../bin/consolidate.ts";

let tmpDir: string;
let logsDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcache-consolidate-test-"));
  logsDir = path.join(tmpDir, "logs");
  fs.mkdirSync(path.join(logsDir, "events"), { recursive: true });
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function todayStem(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function writeEvents(stem: string, events: object[]): string {
  const file = path.join(logsDir, "events", `${stem}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

function jsonAfterHeading(text: string, heading: string): unknown {
  const re = new RegExp(`## ${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*(?:\\n[^\\n#]*)*\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``);
  const m = re.exec(text);
  assert.ok(m, `section "${heading}" not found in report`);
  return JSON.parse(m![1]!);
}

describe("runConsolidate — populated window", () => {
  test("produces report with the expected sections and totals", async () => {
    const now = Date.now();
    const events: object[] = [];

    // 5 successful upstream calls to /2/users/{id}
    for (let i = 0; i < 5; i++) {
      events.push({
        ts: new Date(now - (5 - i) * 60_000).toISOString(),
        request_id: `live-${i}`,
        client_kind: "rest",
        method: "GET",
        url: `https://api.x.com/2/users/${i}`,
        endpoint_template: "/2/users/{id}",
        query_fingerprint: "fp_aaaa",
        requested_fields: ["user.fields=id,username"],
        is_paginated: false,
        operation: "get_user_by_id",
        account_id: String(i),
        status: 200,
        source: "live",
        cache_outcome: "miss",
        duration_ms: 100,
        response_bytes: 500,
        rate_limit_limit: 180,
        rate_limit_remaining: 175 - i,
      });
    }
    // 3 cache hits on the same endpoint template
    for (let i = 0; i < 3; i++) {
      events.push({
        ts: new Date(now - i * 30_000).toISOString(),
        request_id: `hit-${i}`,
        client_kind: "rest",
        method: "GET",
        url: "https://api.x.com/2/users/1",
        endpoint_template: "/2/users/{id}",
        query_fingerprint: "fp_aaaa",
        requested_fields: [],
        is_paginated: false,
        status: 200,
        source: "cache",
        cache_outcome: "hit",
        duration_ms: 0,
        response_bytes: 500,
      });
    }
    // 1 503 error
    events.push({
      ts: new Date(now).toISOString(),
      request_id: "err-1",
      client_kind: "rest",
      method: "GET",
      url: "https://api.x.com/2/users/x",
      endpoint_template: "/2/users/{id}",
      query_fingerprint: "fp_bbbb",
      requested_fields: [],
      is_paginated: false,
      status: 503,
      source: "error",
      cache_outcome: "miss",
      duration_ms: 50,
      response_bytes: 100,
    });
    // 1 paginated chain depth=2
    const chainId = "chain-A";
    for (let depth = 0; depth < 3; depth++) {
      events.push({
        ts: new Date(now - 1000 * (3 - depth)).toISOString(),
        request_id: `pag-${depth}`,
        client_kind: "rest",
        method: "GET",
        url: "https://api.x.com/2/tweets/search/recent",
        endpoint_template: "/2/tweets/search/recent",
        query_fingerprint: "fp_cccc",
        requested_fields: [],
        is_paginated: true,
        pagination_chain_id: chainId,
        pagination_depth: depth,
        status: 200,
        source: "live",
        cache_outcome: "miss",
        duration_ms: 80,
        response_bytes: 1000,
      });
    }

    writeEvents(todayStem(), events);

    const reportPath = path.join(tmpDir, "report.md");
    await runConsolidate(["--since", "1d", "--output", reportPath, "--logs-dir", logsDir]);
    const text = fs.readFileSync(reportPath, "utf8");

    assert.ok(text.startsWith("# xcache-mcp summary "));
    assert.ok(text.includes("## window"));
    assert.ok(text.includes("## top endpoints by upstream calls"));
    assert.ok(text.includes("## hourly time series"));
    assert.ok(text.includes("## errors"));
    assert.ok(text.includes("## pagination depth"));

    const window = jsonAfterHeading(text, "window") as Record<string, number>;
    assert.equal(window.requests_total, 12); // 5 live + 3 hits + 1 err + 3 paginated
    assert.equal(window.upstream_calls, 9); // 5 live + 1 err + 3 paginated
    assert.equal(window.cache_hits, 3);
    assert.equal(window.errors, 1);

    const errors = jsonAfterHeading(text, "errors") as Record<string, Record<string, number>>;
    assert.equal(errors["5xx"]?.["503"], 1);

    const pagination = jsonAfterHeading(text, "pagination depth") as Array<{
      endpoint: string;
      max: number;
    }>;
    const search = pagination.find((p) => p.endpoint === "/2/tweets/search/recent");
    assert.ok(search, "pagination depth row for search endpoint");
    assert.equal(search!.max, 2);

    const endpoints = jsonAfterHeading(text, "top endpoints by upstream calls") as Array<{
      endpoint: string;
      upstream: number;
    }>;
    const usersRow = endpoints.find((e) => e.endpoint === "/2/users/{id}");
    assert.ok(usersRow);
    assert.equal(usersRow!.upstream, 6); // 5 live + 1 error
  });
});

describe("runConsolidate — empty window", () => {
  test("produces a minimal report indicating no events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcache-consolidate-empty-"));
    fs.mkdirSync(path.join(dir, "events"), { recursive: true });
    const reportPath = path.join(dir, "report.md");
    await runConsolidate(["--since", "1d", "--output", reportPath, "--logs-dir", dir]);
    const text = fs.readFileSync(reportPath, "utf8");
    assert.ok(text.includes("(no events in window)"));
    assert.ok(!text.includes("## errors"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runConsolidate — gzipped JSONL", () => {
  test("reads .jsonl.gz files transparently", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcache-consolidate-gz-"));
    fs.mkdirSync(path.join(dir, "events"), { recursive: true });
    // Use yesterday's stem so the filter `dayInWindow` for --since 2d still picks it up.
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const lines = [
      JSON.stringify({
        ts: new Date(Date.now() - 23 * 3_600_000).toISOString(),
        request_id: "gz-1",
        client_kind: "rest",
        method: "GET",
        url: "https://api.x.com/2/users/1",
        endpoint_template: "/2/users/{id}",
        query_fingerprint: "fp_zzz",
        requested_fields: [],
        is_paginated: false,
        status: 200,
        source: "live",
        cache_outcome: "miss",
        duration_ms: 100,
        response_bytes: 500,
      }),
    ];
    const gzPath = path.join(dir, "events", `${yesterday}.jsonl.gz`);
    fs.writeFileSync(gzPath, zlib.gzipSync(lines.join("\n") + "\n"));
    const reportPath = path.join(dir, "report.md");
    await runConsolidate(["--since", "2d", "--output", reportPath, "--logs-dir", dir]);
    const text = fs.readFileSync(reportPath, "utf8");
    assert.ok(!text.includes("(no events in window)"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
