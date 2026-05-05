# xcache-mcp

A personal-scale, **read-only** proxy for the X (Twitter) API v2 with aggressive
caching, intelligent request throttling, and an MCP interface for use by
OpenClaw or any other MCP-aware AI agent.

- **Single bearer token, single user.** App-only auth.
- **Infinite cache retention.** Once we have data, we keep it — even if X
  deletes the post upstream, the proxy remembers it.
- **Throttle, don't TTL.** Cache entries never expire. Whether to refresh
  upstream is decided by per-`(operation, account)` throttle gates configured
  via `app.config.json`.
- **REST mirror + MCP server.** Fastify-served `/2/*` REST mirror for ad-hoc
  curl/script use, plus stateless MCP over Streamable HTTP at `POST /mcp` and
  MCP over stdio.
- **Rich, redacted JSONL logs** for offline AI analysis via the consolidation
  script.

## Setup

Requires Node 22.14+.

```bash
git clone <repo>
cd xcache-mcp
npm install
cp .env.example .env
# Edit .env to set X_BEARER_TOKEN
npm run build
npm start
```

Default listener: `http://127.0.0.1:8787`. Data and logs go to
`~/.openclaw/xcache-mcp/` by default. Out of the box only the two ★ monitoring
tools (`x_posts_since`, `x_follows_changes_since`) are exposed; edit
`tools.enabled` in the config to expose others.

### Environment variables

The proxy reads exactly two env vars. **Everything else lives in
`app.config.json`** so secrets stay out of the file and operational config
stays out of the environment.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `X_BEARER_TOKEN` | yes | — | App-only bearer for `api.x.com` (the only secret) |
| `XCACHE_CONFIG`  | no  | `./app.config.json` | Path to the JSON config file |

### Config file (`app.config.json`)

```jsonc
{
  "version": 1,

  "server": {
    "host": "127.0.0.1",      // bind to 0.0.0.0 for LAN-accessible deployments
    "port": 8787,
    "http":  { "enabled": true },
    "stdio": { "enabled": false } // set to true only for subprocess use
  },

  "storage": {
    "root": "~/.openclaw/xcache-mcp"  // SQLite + logs directory
  },

  "x_api": {
    "base": "https://api.x.com",       // overrideable for testing
    // Optional ISO 8601 floor on how far back the proxy will ask api.x.com
    // for data. Time-bounded requests (e.g. start_time on /tweets) are
    // clamped to this. For paginated endpoints with no time parameter
    // (e.g. /following), the same intent is enforced via early-stop on
    // already-cached IDs. Omit for "no floor" (full historical access).
    "earliest_data_iso": "2025-01-01T00:00:00Z"
  },

  "logging": {
    "level":  "info",  // Fastify / pino level (stderr only)
    "events": true,    // append one JSONL line per request to events/<date>.jsonl
    "bodies": true     // also log full upstream response bodies to bodies/<date>.jsonl
  },

  "tools": {
    // Default exposes only the two ★ monitoring tools. Set to "*" to enable
    // all 7, or list explicit names to enable a subset.
    "enabled": ["x_posts_since", "x_follows_changes_since"],
    // When false, the proxy ignores force_refresh: true from clients on the
    // tools that accept it (x_posts_since, x_follows_changes_since). Use
    // this as a safety net to bound API spend regardless of what the client
    // asks for. Responses include force_refresh_suppressed: true when this
    // policy downgraded a request, so the agent can react.
    "permit_force_refresh": true
  },

  "throttle": {
    "default_min_interval": "24h",
    "operations": {
      "get_user_following":   "24h",
      "get_latest_posts":     "1h",
      "get_user_by_username": "7d",
      "get_user_by_id":       "7d",
      "get_tweet":            "never",
      "verify_posts":         "7d",
      "raw_get":              "24h"
    },
    "error_retry_intervals": {
      "401": "never",  "403": "never",
      "404": "1h",     "429": "1h",
      "5xx": "5m",
      "network": "1m"
    }
  }
}
```

Time strings: `Ns | Nm | Nh | Nd`. `"never"` means once cached, never refresh.
`"always"` means no throttle. `error_retry_intervals` controls how long the
gate stays closed after an upstream failure — typically much shorter than the
success interval so transient outages can recover, but long enough to prevent
retry storms.

`SIGHUP` reloads `app.config.json` in place; `tools.enabled` changes propagate
to in-flight MCP servers immediately. Server-level fields (`host`, `port`,
`http.enabled`, `stdio.enabled`, `logging.level`) require a process restart.

`SIGTERM`/`SIGINT` triggers a clean shutdown that drains the log queue with a
5-second deadline before exit.

## OpenClaw integration

The proxy exposes seven MCP tools. Tool descriptions explicitly steer the
agent toward the higher-level monitoring tools when appropriate.

> **For the agent itself:** see [`AGENT_GUIDE.md`](AGENT_GUIDE.md) — a
> dedicated, instruction-style guide written for an AI client of this MCP
> interface (decision tree, response signals, error patterns, recommended
> workflows). Paste it into the agent's system prompt or expose it as a
> resource.

| Tool | Purpose |
|---|---|
| `x_get_user_by_username` | One-off user lookup by `@username` |
| `x_get_user_by_id` | One-off user lookup by numeric ID |
| `x_get_tweet` | One-off tweet lookup; auto-marks deletion on 404 |
| `x_raw_get` | Escape hatch for arbitrary `/2/*` GETs |
| `x_posts_since` ★ | Preferred: monitor a user's posts over time (uses `since_id` cursor) |
| `x_follows_changes_since` ★ | Preferred: detect new follows / unfollows over time via append-only snapshots |
| `x_verify_posts` | Expensive: verify which cached posts are still live upstream |

### Network deployment (proxy on a separate machine, primary use case)

The proxy is designed to run as a long-lived service on its own host
(physical box, VM, container, or Raspberry Pi). OpenClaw and any other MCP
clients live elsewhere on the LAN and talk to it over HTTP. The agent host
never spawns the proxy and never reads anything from its stdout.

On the proxy host, edit `app.config.json` to bind the listener to a
LAN-reachable address:

```jsonc
"server": {
  "host": "0.0.0.0",        // or a specific LAN IP
  "port": 8787,
  "http":  { "enabled": true },
  "stdio": { "enabled": false }   // unused on a server deployment
}
```

Then start the proxy as you would any service:

```bash
X_BEARER_TOKEN=... node /opt/xcache-mcp/dist/src/index.js
```

On startup the proxy prints a banner to stderr showing the resolved paths,
which is what your service manager (systemd, launchd, supervisord) will
capture in its log:

```
[xcache-mcp] xcache-mcp v0.1.0
[xcache-mcp] config:  /etc/xcache-mcp/app.config.json
[xcache-mcp] storage: /var/lib/xcache-mcp
[xcache-mcp] db:      /var/lib/xcache-mcp/data.db
[xcache-mcp] logs:    /var/lib/xcache-mcp/logs (events=on, bodies=on)
[xcache-mcp] enabled tools (2): x_follows_changes_since, x_posts_since
[xcache-mcp] HTTP listening on 0.0.0.0:8787
```

From OpenClaw (running on a different machine), point its MCP config at the
HTTP URL:

```bash
curl -X POST http://proxy.lan:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Stateless mode means each request creates a fresh `Server` and transport;
there's no session ID and no server→client streaming notifications. `GET`
and `DELETE` on `/mcp` return 405.

**Security note:** the proxy has no auth on its HTTP listener — restrict
network access at the firewall / reverse-proxy layer, or bind to `127.0.0.1`
plus an SSH tunnel from the agent host. The proxy is read-only against X
(no write tools exist), but it does hold the bearer token and serve cached
content to anyone who can reach the port.

### Local subprocess mode (alternative)

If the agent runs on the same machine, you can also spawn the proxy as a
subprocess and talk to it via stdio. Write a minimal config that flips the
defaults:

```jsonc
// ~/openclaw/xcache.app.config.json
{
  "version": 1,
  "server": { "http": { "enabled": false }, "stdio": { "enabled": true } },
  "tools":  { "enabled": "*" },
  "throttle": { "default_min_interval": "24h", "operations": {}, "error_retry_intervals": {} }
}
```

```json
{
  "mcpServers": {
    "xcache": {
      "command": "node",
      "args": ["/path/to/xcache-mcp/dist/src/index.js"],
      "env": {
        "X_BEARER_TOKEN": "...",
        "XCACHE_CONFIG": "/home/you/openclaw/xcache.app.config.json"
      }
    }
  }
}
```

When `stdio.enabled` is true, stdout is the MCP protocol channel — all
human-readable diagnostics go to stderr.

## Inspection

### REST passthrough

```bash
# Forward to api.x.com/2/users/by/username/xdevelopers, cache forever:
curl http://localhost:8787/2/users/by/username/xdevelopers

# Second identical call within 7 days (the get_user_by_username throttle) is
# served from cache — no upstream traffic, no event log entry that says "live".
curl http://localhost:8787/2/users/by/username/xdevelopers
```

The response includes an `x-xcache-source` header: `live`, `cache`, or
`stale_cache` (returned when upstream errored but a cached body exists).

### Logs

Logs live in `$XCACHE_ROOT/logs/`:

- `events/YYYY-MM-DD.jsonl` — one JSON line per request (cache lookup or
  upstream call). Metadata only, no body.
- `bodies/YYYY-MM-DD.jsonl` — one JSON line per upstream call,
  `{request_id, body}`. Disabled via `logging.bodies: false` in
  `app.config.json`. The events JSONL itself can be disabled with
  `logging.events: false` for very high-throughput deployments where you
  only want body archives.

Files older than 7 days are gzipped to `*.jsonl.gz`. Mode `0600`. The bearer
token is **redacted at source** before any row enters the log queue — verify
with `grep -r "$X_BEARER_TOKEN" $XCACHE_ROOT/logs` (no matches expected).

### Consolidation

Generate a Markdown summary tuned for downstream AI ingestion:

```bash
# Last 7 days
npx xcache-mcp-consolidate --since 7d --output report.md

# Specific window
npx xcache-mcp-consolidate --from 2026-04-29 --to 2026-05-05 --output report.md
```

Or in dev:

```bash
npm run consolidate -- --since 1d --output report.md
```

The output mixes human prose with dense JSON code blocks. Empty sections are
omitted. Target output size for one week: 5–15K tokens.

## Quality pipeline

```bash
npm run lint          # ESLint with typescript-eslint strict preset
npm run format        # Prettier: rewrite to canonical style
npm run format:check  # Prettier: fail on any mis-formatted file
npm run build         # tsc --strict
npm test              # 114 unit tests (~1s, no network)
npm run test:coverage # unit tests + per-file line/branch coverage report
npm run test:smoke    # end-to-end smoke test against an in-process fake X API
npm run ci            # the lot, in order — same as GitHub Actions runs
```

GitHub Actions (`.github/workflows/ci.yml`) runs lint+format-check, build,
unit tests with coverage, and the smoke test on every push and PR.

The unit suite covers `parseInterval`, gate state transitions, `canonicalUrl`
/ `queryFingerprint`, `url_cache` round-trip, posts upsert conflict semantics,
`markPostDeleted` idempotency, post cursor monotonicity, follow-snapshot
insert + diff, header redaction, bounded log queue overflow + drop counter,
log mode 0600, `extractTweetId` edge cases, `rowToPostRecord` shape, and the
consolidate script's section structure.

`scripts/smoke-test.ts` spins up an in-process fake X API and exercises every
acceptance criterion end-to-end. Coverage on the unit suite alone is 100% on
`gate.ts`, 99% on `cache.ts`, ~80% branches overall; lower line coverage on
`tools.ts` and `xapi.ts` is by design — those modules' main flows are
exercised by the smoke test rather than unit tests, to avoid brittle network
mocking.

## Living spec (Gherkin)

[`features/`](features/) contains 18 Gherkin feature files (~2,000 lines)
covering every behavior in this project — gate states, caching philosophy,
REST passthrough, both MCP transports, all 7 tools, logging, security,
deletion handling, consolidation, and process lifecycle. See
[`features/README.md`](features/README.md) for the index. No runner is wired
up; the files exist as living documentation that survives implementation
changes.

## Caching philosophy

Cache is **infinite retention**, not TTL. Two consequences:

1. Cache lookup never returns a "miss" because of expiration. If we have data,
   we return it.
2. The throttle gate is the only mechanism that limits upstream calls.
   Whether to *refresh* (call upstream to get newer data) is decided by the
   `fetch_gate` table and the throttle config — not by cache age.

The gate is updated on **both** success and failure of an upstream call, with
different intervals (normal `operations[op]` on success,
`error_retry_intervals[status]` on failure). This prevents retry storms while
letting transient failures recover faster than the full polling cadence.

## Deletion handling

A post in the `posts` table has `deleted_at` set to a timestamp when the proxy
first observes that X no longer returns it upstream. The post row is **never**
deleted from our store, regardless of upstream state.

Detection mechanisms:

1. **`x_get_tweet` 404.** Marks the cached row deleted and returns it with
   `deleted: true`.
2. **Bulk lookup error array.** `/2/tweets?ids=...` returns `errors[]` with
   not-found entries. Each cached row found there is marked deleted.
3. **`x_verify_posts` operation.** Re-fetches a window of cached posts in
   100-ID batches and flags any that come back missing. Gated under the
   `verify_posts` config interval (default 7d).

The normal `since_id`-driven refresh in `x_posts_since` does **not** detect
deletions — it only asks X for tweets newer than the cursor. Use
`x_verify_posts` for active deletion detection on older posts.

## Schema

SQLite at `$XCACHE_ROOT/data.db`, WAL mode. Tables:

- `url_cache` — generic infinite-retention KV cache for ad-hoc lookups
- `fetch_gate` — per-`(operation, account_id)` throttle state
- `posts` — accumulator for tweets; never deleted; `deleted_at` flag on
  upstream removal
- `post_cursors` — per-user `since_id` resume points
- `follow_snapshots` + `follow_snapshot_members` — append-only follow lists
- `follow_user_details` — last-known details for any user we've seen in a
  follow snapshot
- `proxy_meta` — process-level counters (e.g., `dropped_log_entries`)
- `schema_version` — migrations

## Non-goals

- Write operations (post, like, follow, DM, etc.) — read-only by design.
- OAuth user-context flows — app-only bearer only.
- Multi-user / multi-tenant separation.
- TTL-based cache expiration.
- Real-time analytics dashboard (consolidation script is offline batch).
- Distributed tracing / OpenTelemetry export.
- Server-pushed MCP notifications.

## License

MIT.
