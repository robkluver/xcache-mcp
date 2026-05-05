# Gherkin feature files

Living documentation for xcache-mcp expressed as Gherkin scenarios. These
files describe **observable behavior** — what the proxy does from the outside,
not how it does it. They are intended as:

1. A human-readable spec mirror that survives implementation changes.
2. A future hook for cucumber-style BDD runners (none is wired up yet).
3. A checklist for reviewers and contributors confirming feature parity.

## Index

### Cross-cutting concerns

| File | Scope |
|---|---|
| [`configuration.feature`](configuration.feature) | env vars, throttle config parsing, SIGHUP reload |
| [`throttle_gate.feature`](throttle_gate.feature) | per-`(operation, account_id)` gate state matrix and transitions |
| [`caching.feature`](caching.feature) | infinite retention, throttle-not-TTL, stale-cache fallback, append-only invariants |
| [`rest_passthrough.feature`](rest_passthrough.feature) | `GET /2/*` forwarding, `/healthz`, `/`, `x-xcache-source` header |
| [`mcp_http_transport.feature`](mcp_http_transport.feature) | `POST /mcp`, stateless mode, `tools/list` and `tools/call`, 405 on `GET`/`DELETE` |
| [`mcp_stdio_transport.feature`](mcp_stdio_transport.feature) | OpenClaw subprocess mode, stdout = protocol channel |
| [`logging.feature`](logging.feature) | JSONL events + bodies, daily rotation, gzip > 7d, mode 0600, queue overflow, drain-on-shutdown |
| [`security.feature`](security.feature) | bearer-token redaction across all surfaces, read-only invariants, file modes |
| [`deletion_handling.feature`](deletion_handling.feature) | three deletion-detection mechanisms, never-deleted-from-store invariant |
| [`consolidation.feature`](consolidation.feature) | `bin/consolidate.ts` Markdown report sections, time windows, gzipped reads, token-efficiency rules |
| [`lifecycle.feature`](lifecycle.feature) | startup banners, signal handling, graceful shutdown |

### Tool features (one per MCP tool)

| File | Tool |
|---|---|
| [`tool_x_get_user_by_username.feature`](tool_x_get_user_by_username.feature) | `x_get_user_by_username` |
| [`tool_x_get_user_by_id.feature`](tool_x_get_user_by_id.feature) | `x_get_user_by_id` |
| [`tool_x_get_tweet.feature`](tool_x_get_tweet.feature) | `x_get_tweet` (incl. ID/URL extraction, `gate=never`, deletion detection) |
| [`tool_x_raw_get.feature`](tool_x_raw_get.feature) | `x_raw_get` (escape hatch) |
| [`tool_x_posts_since.feature`](tool_x_posts_since.feature) | `x_posts_since` ★ |
| [`tool_x_follows_changes_since.feature`](tool_x_follows_changes_since.feature) | `x_follows_changes_since` ★ |
| [`tool_x_verify_posts.feature`](tool_x_verify_posts.feature) | `x_verify_posts` (expensive) |

## Tag conventions

Scenarios are tagged so a runner can select subsets. Common tags:

- `@configuration`, `@lifecycle`, `@logging`, `@security`, `@caching`, `@throttle`, `@gate`, `@deletion`, `@consolidation`
- `@rest`, `@mcp`, `@http`, `@stdio`, `@passthrough`
- `@tool` plus the specific tool name (e.g. `@x_posts_since`)
- `@monitoring` for the two preferred-for-monitoring tools
- `@expensive` for `x_verify_posts`
- `@philosophy` for non-mechanical "why" scenarios

## Running them

No runner is currently wired up. The existing test suites that verify these
behaviors are:

- `npm test` — 114 unit tests across the implementation modules
- `npm run test:smoke` — end-to-end integration test against an in-process
  fake X API

If you want to execute the Gherkin directly, install `@cucumber/cucumber`
and write step definitions that reuse the existing test scaffolding (the
fake X API in `scripts/smoke-test.ts` is already designed for this).
