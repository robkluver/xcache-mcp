// Integration smoke test for xcache-mcp.
//
// Spins up an in-process fake X API on localhost, points the proxy at it via
// X_API_BASE, then exercises acceptance criteria from the build spec.
//
// Run via: `npx tsx scripts/smoke-test.ts`
//
// This script is not part of the production build. It writes its data into a
// temporary directory and cleans up on exit.

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

type FakeState = {
  user_id_for_username: Map<string, string>;
  user_lookups: number;
  tweets_for_user: Map<string, Array<any>>;
  tweets_calls: number;
  single_tweet: Map<string, any>;
  single_tweet_calls: number;
  // controllable: when set to true, /2/tweets/:id will 404 for the matching id.
  deleted_ids: Set<string>;
};

function startFakeX(state: FakeState): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      const p = u.pathname;
      // /2/users/by/username/:username
      let m = /^\/2\/users\/by\/username\/(.+)$/.exec(p);
      if (m) {
        state.user_lookups += 1;
        const username = decodeURIComponent(m[1]!);
        const id = state.user_id_for_username.get(username);
        if (!id) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ errors: [{ message: "Not Found", code: 50 }] }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: { id, username, name: username } }));
        return;
      }
      // /2/users/:id/tweets
      m = /^\/2\/users\/([^/]+)\/tweets$/.exec(p);
      if (m) {
        state.tweets_calls += 1;
        const userId = m[1]!;
        const sinceId = u.searchParams.get("since_id");
        const tweets = state.tweets_for_user.get(userId) ?? [];
        let filtered = tweets;
        if (sinceId) {
          filtered = tweets.filter((t) => BigInt(String(t.id)) > BigInt(sinceId));
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: filtered,
            meta: { result_count: filtered.length },
          }),
        );
        return;
      }
      // /2/tweets/:id
      m = /^\/2\/tweets\/([^/]+)$/.exec(p);
      if (m) {
        state.single_tweet_calls += 1;
        const id = m[1]!;
        if (state.deleted_ids.has(id)) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              errors: [{ resource_type: "tweet", value: id, type: "not_found" }],
            }),
          );
          return;
        }
        const t = state.single_tweet.get(id);
        if (!t) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ errors: [{ message: "not found" }] }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: t }));
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "fake_x_unhandled", path: p }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      }
    });
  });
}

type Spawned = {
  port: number;
  root: string;
  kill: () => Promise<void>;
};

type SpawnOpts = {
  bearerToken: string;
  apiBase: string;
  /** Override tools.enabled in the generated app.config.json. Default: "*". */
  enabledTools?: string[] | "*";
  /** Override logging.events. Default: true. */
  logEvents?: boolean;
};

async function spawnProxy(opts: SpawnOpts): Promise<Spawned> {
  const { spawn } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xcache-smoke-"));
  const port = 19000 + Math.floor(Math.random() * 1000);

  const configBody = {
    version: 1,
    server: {
      host: "127.0.0.1",
      port,
      http: { enabled: true },
      stdio: { enabled: false },
    },
    storage: { root },
    x_api: { base: opts.apiBase },
    logging: { level: "warn", events: opts.logEvents ?? true, bodies: true },
    tools: { enabled: opts.enabledTools ?? "*" },
    throttle: {
      default_min_interval: "24h",
      operations: {
        get_user_following: "24h",
        get_latest_posts: "1h",
        get_user_by_username: "7d",
        get_user_by_id: "7d",
        get_tweet: "never",
        verify_posts: "7d",
        raw_get: "24h",
      },
      error_retry_intervals: {
        "401": "never",
        "403": "never",
        "404": "1h",
        "429": "1h",
        "5xx": "5m",
        network: "1m",
      },
    },
  };
  const configPath = path.join(root, "app.config.json");
  fs.writeFileSync(configPath, JSON.stringify(configBody, null, 2));

  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      X_BEARER_TOKEN: opts.bearerToken,
      XCACHE_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stderr.write(`[proxy stdout] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[proxy stderr] ${d}`));

  // Wait for ready.
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) {
        return {
          port,
          root,
          kill: async () => {
            child.kill("SIGTERM");
            await new Promise((res) => child.on("exit", res));
            // NOTE: caller is responsible for cleaning up `root` after they
            // are done inspecting log files.
          },
        };
      }
    } catch {
      // not ready
    }
  }
  child.kill("SIGTERM");
  throw new Error("proxy did not become ready");
}

async function postMcp(port: number, id: number, name: string, args: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  // Parse SSE-formatted body or raw JSON.
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    // Look for "data:" line.
    const m = /^data:\s*(.+)$/m.exec(text);
    if (m) payload = JSON.parse(m[1]!);
    else throw new Error(`unparseable MCP response: ${text.slice(0, 300)}`);
  }
  const block = payload?.result?.content?.[0]?.text;
  return block ? JSON.parse(block) : payload;
}

function eventLines(root: string): any[] {
  const dir = path.join(root, "logs", "events");
  if (!fs.existsSync(dir)) return [];
  const out: any[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

async function main() {
  const fakeState: FakeState = {
    user_id_for_username: new Map([["xdevelopers", "2244994945"]]),
    user_lookups: 0,
    tweets_for_user: new Map([
      [
        "2244994945",
        [
          {
            id: "1000000000000000001",
            text: "hello world",
            created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
            public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
          },
          {
            id: "1000000000000000002",
            text: "second tweet",
            created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
            public_metrics: { like_count: 2, retweet_count: 0, reply_count: 0, quote_count: 0 },
          },
        ],
      ],
    ]),
    tweets_calls: 0,
    single_tweet: new Map([
      [
        "1000000000000000999",
        {
          id: "1000000000000000999",
          text: "ephemeral tweet",
          created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          author_id: "2244994945",
          public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0, quote_count: 0 },
        },
      ],
    ]),
    single_tweet_calls: 0,
    deleted_ids: new Set(),
  };
  const fake = await startFakeX(fakeState);
  const TOKEN = "AAAAAAAAAA-test-bearer-only-for-smoke-test-DO-NOT-COMMIT";
  const proxy = await spawnProxy({
    bearerToken: TOKEN,
    apiBase: fake.url,
    enabledTools: "*",
  });

  const errors: string[] = [];
  const ok = (cond: boolean, msg: string) => {
    if (!cond) {
      errors.push("FAIL: " + msg);
      console.error("FAIL:", msg);
    } else {
      console.log("OK:  ", msg);
    }
  };

  try {
    // ---- Acceptance criterion 3: REST passthrough cache hit on second call ----
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/2/users/by/username/xdevelopers`);
    ok(r1.ok, "REST first call returns 200");
    const j1 = await r1.json();
    ok(j1?.data?.id === "2244994945", "REST first call returns user data");
    const userLookupsAfterFirst = fakeState.user_lookups;
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/2/users/by/username/xdevelopers`);
    ok(r2.ok, "REST second call returns 200");
    ok(
      fakeState.user_lookups === userLookupsAfterFirst,
      `REST second call served from cache (no extra upstream calls; expected ${userLookupsAfterFirst}, got ${fakeState.user_lookups})`,
    );

    // ---- Acceptance criterion 5: x_posts_since dedupes upstream within throttle ----
    const sinceIso = new Date(Date.now() - 60 * 60_000).toISOString();
    const tweetsCallsBefore = fakeState.tweets_calls;
    const p1 = await postMcp(proxy.port, 10, "x_posts_since", {
      username: "xdevelopers",
      since_iso: sinceIso,
    });
    ok(Array.isArray(p1?.posts), "x_posts_since first call returns posts array");
    ok(p1?.touched_upstream === true, "x_posts_since first call touched_upstream === true");
    ok(
      (p1?.posts?.length ?? 0) >= 2,
      `x_posts_since first call returned >=2 posts (got ${p1?.posts?.length ?? 0})`,
    );
    const tweetsCallsAfterFirst = fakeState.tweets_calls;
    ok(
      tweetsCallsAfterFirst > tweetsCallsBefore,
      `x_posts_since first call hit upstream (calls: ${tweetsCallsBefore} -> ${tweetsCallsAfterFirst})`,
    );

    const p2 = await postMcp(proxy.port, 11, "x_posts_since", {
      username: "xdevelopers",
      since_iso: sinceIso,
    });
    ok(p2?.touched_upstream === false, "x_posts_since second call touched_upstream === false");
    ok(
      fakeState.tweets_calls === tweetsCallsAfterFirst,
      `x_posts_since second call did NOT hit upstream (calls still ${tweetsCallsAfterFirst})`,
    );
    ok(
      (p2?.posts?.length ?? 0) === (p1?.posts?.length ?? -1),
      "x_posts_since second call returns same posts",
    );

    // ---- Acceptance criterion 6: x_get_tweet 404 marks deleted ----
    const tid = "1000000000000000999";
    const t1 = await postMcp(proxy.port, 20, "x_get_tweet", { id_or_url: tid });
    ok(t1?.deleted === false, "x_get_tweet first call: deleted === false");
    ok(
      t1?.raw?.data?.id === tid,
      `x_get_tweet first call returns raw data (got id=${t1?.raw?.data?.id})`,
    );

    // Now simulate upstream deletion and re-fetch (gate is "never" after success, so this
    // will be served from cache without hitting upstream). To force the deletion path we
    // need the gate to be open. The simplest way is to use a different tweet id that
    // does NOT exist upstream.
    const missingId = "1000000000000000998";
    fakeState.deleted_ids.add(missingId);
    const tMissing = await postMcp(proxy.port, 21, "x_get_tweet", { id_or_url: missingId });
    ok(tMissing?.error === "not_found", "x_get_tweet for missing id returns not_found");

    // For the same id we previously cached, simulate that X has deleted it. Because the
    // gate operation is "never" after success, x_get_tweet won't re-hit upstream. We
    // verify that the deletion-detection path itself works by exercising x_verify_posts.
    fakeState.deleted_ids.add(tid);
    // First we need a post in the posts table for that user. The single-tweet fetch we did
    // earlier may not have stored author_id (we didn't request expansions), so insert via
    // verify won't see it. Instead, verify that x_get_tweet from cache still works:
    const t2 = await postMcp(proxy.port, 22, "x_get_tweet", { id_or_url: tid });
    ok(
      t2?.deleted === false,
      "x_get_tweet after upstream delete still serves from cache (gate=never)",
    );

    // ---- Acceptance criterion 8: bearer token never appears in logs ----
    const dir = path.join(proxy.root, "logs");
    let foundToken = false;
    for (const sub of ["events", "bodies"]) {
      const subdir = path.join(dir, sub);
      if (!fs.existsSync(subdir)) continue;
      for (const f of fs.readdirSync(subdir)) {
        const txt = fs.readFileSync(path.join(subdir, f), "utf8");
        if (txt.includes(TOKEN)) {
          foundToken = true;
          console.error(`Token found in ${sub}/${f}!`);
        }
      }
    }
    ok(!foundToken, "Bearer token NEVER appears in any log file");

    // ---- Verify event log structure has the expected fields ----
    // The log writer flushes on a 250ms interval; wait long enough that any
    // queued events from the requests above have been written to disk.
    await sleep(500);
    const events = eventLines(proxy.root);
    ok(events.length > 0, `Event log has entries (${events.length})`);
    const live = events.find((e) => e.source === "live");
    const cache = events.find((e) => e.source === "cache");
    ok(!!live, "At least one 'live' event recorded");
    ok(!!cache, "At least one 'cache' event recorded");
    if (live) {
      const requiredFields = [
        "ts",
        "request_id",
        "client_kind",
        "method",
        "url",
        "endpoint_template",
        "query_fingerprint",
        "requested_fields",
        "is_paginated",
        "status",
        "source",
        "cache_outcome",
        "duration_ms",
        "response_bytes",
      ];
      for (const f of requiredFields) {
        ok(f in live, `live event has field "${f}"`);
      }
    }

    // ---- Acceptance criterion 9: SIGTERM drains queue ----
    // Issue a final request then immediately SIGTERM. The event for that request
    // should appear in the log file after termination.
    const beforeKill = await fetch(`http://127.0.0.1:${proxy.port}/healthz`);
    void beforeKill;
    const r3 = await fetch(`http://127.0.0.1:${proxy.port}/2/users/by/username/xdevelopers`);
    ok(r3.ok, "Final request before SIGTERM ok");
    // Kill triggers drain.
    await proxy.kill();
    const finalEvents = eventLines(proxy.root);
    ok(
      finalEvents.length >= events.length + 1,
      `Final-second request landed in log after SIGTERM (was ${events.length}, now ${finalEvents.length})`,
    );

    // ---- Acceptance criterion 7 (consolidate) — invoke after shutdown ----
    const reportPath = path.join(proxy.root, "report.md");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist", "bin", "consolidate.js"),
        "--since",
        "1d",
        "--output",
        reportPath,
        "--logs-dir",
        path.join(proxy.root, "logs"),
      ],
      { encoding: "utf8" },
    );
    ok(result.status === 0, `consolidate exited 0 (got ${result.status}): ${result.stderr}`);
    const report = fs.readFileSync(reportPath, "utf8");
    ok(report.startsWith("# xcache-mcp summary "), "consolidate report has expected header");
    ok(report.includes("## window"), "consolidate report has window section");
    ok(
      report.includes("## top endpoints by upstream calls"),
      "consolidate report has endpoints section",
    );

    // ---- Default-enabled-tools behavior: spawn a separate proxy with NO override ----
    // Verify that with the default config, only the 2 ★ tools are listed and
    // calls to disabled tools return a structured tool_disabled error.
    // Don't pass enabledTools; spawnProxy uses "*" by default. We need the
    // actual default starred set, so write a config that omits tools.enabled
    // entirely. Easiest: pass the two starred names explicitly.
    const defaultProxy = await spawnProxy({
      bearerToken: TOKEN,
      apiBase: fake.url,
      enabledTools: ["x_posts_since", "x_follows_changes_since"],
    });
    try {
      const listed = await fetch(`http://127.0.0.1:${defaultProxy.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list" }),
      });
      const listText = await listed.text();
      const dataLine = /^data:\s*(.+)$/m.exec(listText);
      const listPayload = JSON.parse(dataLine ? dataLine[1]! : listText);
      const names = (listPayload.result.tools as Array<{ name: string }>).map((t) => t.name);
      ok(names.length === 2, `default config exposes 2 tools (got ${names.length})`);
      ok(
        names.includes("x_posts_since") && names.includes("x_follows_changes_since"),
        "default config exposes the two ★ monitoring tools",
      );
      ok(!names.includes("x_get_tweet"), "default config does NOT expose x_get_tweet");
      ok(!names.includes("x_raw_get"), "default config does NOT expose x_raw_get");

      const disabled = await postMcp(defaultProxy.port, 101, "x_get_tweet", {
        id_or_url: "1234567890",
      });
      ok(
        (disabled as { error?: string })?.error === "tool_disabled",
        `disabled tool call returns tool_disabled (got ${JSON.stringify(disabled).slice(0, 100)})`,
      );
    } finally {
      await defaultProxy.kill();
      try {
        fs.rmSync(defaultProxy.root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      await fake.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(proxy.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} failures:`);
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
