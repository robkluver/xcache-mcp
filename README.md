# xcache-mcp

A personal-scale, **read-only** proxy for the X (Twitter) API v2 with aggressive
caching, intelligent request throttling, and an MCP interface for use by
OpenClaw or any other MCP-aware AI agent.

- **Single bearer token, single user.** App-only auth.
- **Infinite cache retention.** Once we have data, we keep it — even if X
  deletes the post upstream, the proxy remembers it.
- **Throttle, don't TTL.** Cache entries never expire. Whether to refresh
  upstream is decided by per-`(operation, account)` throttle gates configured
  via `throttle.config.json`.
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
`~/.openclaw/xcache-mcp/` by default (override with `XCACHE_ROOT`).

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `X_BEARER_TOKEN` | — | App-only bearer for `api.x.com` (required for upstream calls) |
| `XCACHE_PORT` | `8787` | HTTP listener port |
| `XCACHE_HOST` | `127.0.0.1` | HTTP listener host |
| `XCACHE_ROOT` | `~/.openclaw/xcache-mcp` | Data directory (db, logs) |
| `XCACHE_THROTTLE_CONFIG` | `./throttle.config.json` | Path to throttle config |
| `XCACHE_NO_HTTP` | — | Set to `1` to skip the HTTP listener |
| `XCACHE_NO_STDIO` | — | Set to `1` to skip the MCP stdio transport |
| `XCACHE_LOG_BODIES` | `1` | Set to `0` to skip writing request bodies log |
| `LOG_LEVEL` | `info` | Fastify/pino log level (logs to stderr only) |
| `X_API_BASE` | `https://api.x.com` | Override for testing |

`SIGHUP` reloads `throttle.config.json` without restarting.

`SIGTERM`/`SIGINT` triggers a clean shutdown that drains the log queue with a
5-second deadline before exit.

### Throttle config

`throttle.config.json` controls how often each operation can call upstream.
Time strings: `Ns | Nm | Nh | Nd`. `"never"` means once cached, never
refresh. `"always"` means no throttle. `error_retry_intervals` controls how
long the gate stays closed after an upstream failure — typically much shorter
than the success interval so transient outages can recover, but long enough to
prevent retry storms.

Default values:

| Operation | Interval |
|---|---|
| `get_user_following` | 24h |
| `get_latest_posts` | 1h |
| `get_user_by_username` | 7d |
| `get_user_by_id` | 7d |
| `get_tweet` | never (once cached) |
| `verify_posts` | 7d |
| `raw_get` | 24h |

## OpenClaw integration

The proxy exposes seven MCP tools. Tool descriptions explicitly steer the
agent toward the higher-level monitoring tools when appropriate.

| Tool | Purpose |
|---|---|
| `x_get_user_by_username` | One-off user lookup by `@username` |
| `x_get_user_by_id` | One-off user lookup by numeric ID |
| `x_get_tweet` | One-off tweet lookup; auto-marks deletion on 404 |
| `x_raw_get` | Escape hatch for arbitrary `/2/*` GETs |
| `x_posts_since` ★ | Preferred: monitor a user's posts over time (uses `since_id` cursor) |
| `x_follows_changes_since` ★ | Preferred: detect new follows / unfollows over time via append-only snapshots |
| `x_verify_posts` | Expensive: verify which cached posts are still live upstream |

### MCP via stdio (recommended for OpenClaw)

OpenClaw spawns the proxy as a subprocess and talks to it over stdio. Since
stdout is the MCP protocol channel, all human-readable diagnostics go to
stderr.

Add to OpenClaw's MCP config:

```json
{
  "mcpServers": {
    "xcache": {
      "command": "node",
      "args": ["/path/to/xcache-mcp/dist/src/index.js"],
      "env": {
        "X_BEARER_TOKEN": "...",
        "XCACHE_NO_HTTP": "1"
      }
    }
  }
}
```

`XCACHE_NO_HTTP=1` keeps the process strictly stdio-only when used as a
subprocess. Omit it if you also want the REST mirror running.

### MCP via HTTP (Streamable, stateless)

```bash
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Stateless mode means each request creates a fresh `Server` and transport;
there's no session ID and no server→client streaming notifications. `GET` and
`DELETE` on `/mcp` return 405.

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
  `{request_id, body}`. Disabled via `XCACHE_LOG_BODIES=0`.

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
