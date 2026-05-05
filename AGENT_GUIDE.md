# Instructions for an AI client of the xcache-mcp interface

You are an AI agent calling **xcache-mcp**, a personal-scale read-only proxy
for the X (Twitter) API v2. This document tells you *what* the server lets
you do, *how to choose tools*, and *how to interpret the responses* so you
spend as little upstream API quota as possible.

Read this once at the start of each session. The proxy itself stays the same
across sessions — it is a single-user cache with infinite retention.

---

## What the proxy is

- **Read-only.** You can look up users, tweets, follow lists, and recent
  posts. You cannot post, like, follow, or DM. No write tools exist.
- **Single bearer token.** The proxy authenticates against X on your behalf.
  You never see, send, or pass the token.
- **Infinite-retention cache.** Every successful upstream response is stored
  forever. Even if X later deletes a post, the proxy remembers it.
- **Throttled, not TTL'd.** Whether the proxy refreshes from X is decided by
  per-`(operation, account)` throttle gates, not by cache age. Many calls
  return at near-zero cost because the gate is closed.

---

## Tools at a glance

| # | Tool | Purpose | Default refresh interval |
|---|------|---------|--------------------------|
| 1 | `x_get_user_by_username` | One-off profile lookup by `@handle` | 7d |
| 2 | `x_get_user_by_id` | One-off profile lookup by numeric ID | 7d |
| 3 | `x_get_tweet` | One-off tweet lookup; auto-detects deletion | never (after first cache) |
| 4 | `x_raw_get` | Escape hatch for arbitrary `/2/*` GETs | 24h |
| 5 | `x_posts_since` ★ | **Preferred for monitoring posts over time** | 1h |
| 6 | `x_follows_changes_since` ★ | **Preferred for monitoring follow-list changes** | 24h |
| 7 | `x_verify_posts` | Active deletion sweep (expensive — many requests) | 7d |

Tools marked ★ should be your default for any *recurring* observation of a
user. They cache incrementally and cost essentially nothing once warm.

---

## Decision tree

Use this every time you reach for a tool:

1. **"I need to read a user's posts repeatedly over time."**
   → **`x_posts_since`**. Pass an ISO `since_iso` and the username. The proxy
   keeps a `since_id` cursor and only fetches new tweets per call. Repeated
   calls within the throttle window return cached data with
   `touched_upstream: false`.

2. **"I want to know if someone followed/unfollowed accounts."**
   → **`x_follows_changes_since`**. Pass `since_iso` and the username. The
   proxy diffs append-only snapshots and returns `new_follows` and
   `unfollows`. The very first call returns the entire current follow list
   as `new_follows` with `first_observation: true`.

3. **"I need to confirm a specific tweet still exists upstream right now."**
   → **`x_verify_posts`** for batch verification of cached posts (expensive,
   gated 7d), or **`x_get_tweet`** for a single tweet. Both update
   `deleted`/`deleted_at` if the tweet is gone.

4. **"I just need a single user's profile."**
   → **`x_get_user_by_username`** (preferred) or **`x_get_user_by_id`**. One
   call per `@handle` per week is essentially free; the result is cached.

5. **"I want a single tweet's text and metrics."**
   → **`x_get_tweet`**. Once cached, the proxy never re-fetches it from
   upstream — you'll get the same response on every subsequent call,
   essentially free.

6. **"None of the above fit."**
   → **`x_raw_get`**. Pass `path` (must start with `/2/`) and optional
   `params`. Use this only if a higher-level tool doesn't cover the
   endpoint — they cache better and provide structured deletion tracking.

**Anti-patterns:**
- ✗ Calling `x_get_tweet` in a loop to monitor a user's recent posts.
  Use `x_posts_since` instead.
- ✗ Calling `x_raw_get` to walk `/2/users/:id/following`.
  Use `x_follows_changes_since`.
- ✗ Calling `x_posts_since` repeatedly inside the same logical task hoping
  to force a refresh. The throttle gate dedups identical calls within the
  configured interval. Inspect `gate.next_eligible_at` and respect it.
- ✗ Setting `force_refresh: true` casually. It bypasses the gate and costs
  upstream quota. Use it only when the user explicitly asks for fresh data.

---

## Time format

- All inputs that take an `since_iso` parameter expect **ISO 8601** with a
  timezone designator. UTC `Z` is recommended:
  `"2026-05-05T10:42:18Z"` or `"2026-05-05T10:42:18.421Z"`.
- All ISO timestamps in responses (`created_at`, `first_observed_at`,
  `last_observed_at`, `deleted_at`, `gate.last_fetched_at`,
  `gate.next_eligible_at`, etc.) are also UTC ISO 8601.
- If you pass garbage, the response is `{"error": "invalid_since_iso", ...}`.

---

## How to read the responses

Across all tools, watch for these signals:

### `touched_upstream` (on `x_posts_since`, `x_follows_changes_since`)

- `true` → the proxy hit the X API for you. It cost real quota.
- `false` → served entirely from cache. Cost zero.

You don't need to retry when this is `false`. The cached data is the most
recent the proxy is willing to serve.

### `gate.next_eligible_at`

The earliest UTC ISO time at which calling this tool with the same
`(operation, account)` will hit upstream again. If you call earlier, you'll
get the same cached result with `touched_upstream: false`. Plan your polling
cadence around this number.

### `deleted`, `deleted_at`

- `deleted: false` → the post was live as of the last upstream observation.
- `deleted: true` → the proxy has observed that X removed the post. The
  text, metrics, and `created_at` you see are the **last known** values
  before deletion. They will not change.

The proxy never deletes its own copy of a post, regardless of upstream
state. You can quote a deleted post — just label it as such using the
`deleted` flag.

### `first_observation` (on `x_follows_changes_since`)

- `true` → there was no prior snapshot for this user. `new_follows` lists
  the entire current follow set, `unfollows` is empty. This is normal on
  the first call for a user; do not treat it as a real follow event.
- `false` → the diff is meaningful.

### `precision_note` (on `x_follows_changes_since`)

A short human-readable string explaining the known imprecisions of this
tool. Two things to know:

1. **Snapshot cadence over-inclusion.** The baseline may slightly precede
   `since_iso`, so `new_follows` may include accounts followed shortly
   before the requested cutoff. Surface this if the cutoff is critical.
2. **Partial walks under-detect unfollows.** The proxy walks
   `/2/users/:id/following` newest-first and stops paginating once it hits
   accounts already cached. This makes repeated calls cheap, but it also
   means: **if someone in your previous snapshot has since unfollowed and
   was past the early-stop cutoff, the proxy will keep reporting them as
   followed.** `new_follows` is reliable; `unfollows` is best-effort.

### `latest_walk_kind` and `unfollows_may_be_stale` (on `x_follows_changes_since`)

- `latest_walk_kind` = `"complete"` → the most recent snapshot was a full
  walk. Both `new_follows` and `unfollows` are authoritative.
- `latest_walk_kind` = `"partial"` → the most recent snapshot stopped early
  on a cached ID. `new_follows` is still authoritative. `unfollows` may be
  missing accounts that were unfollowed past the early-stop point. The
  flag `unfollows_may_be_stale: true` is set in this case.

If you genuinely need an authoritative answer about who someone has
unfollowed (rare — most agent use cases only care about *new* follows),
call `x_follows_changes_since` with `force_refresh: true`. That bypasses
the throttle gate AND walks to completion. Expensive; do it sparingly.

### `truncated` (on `x_posts_since`)

- `true` → the `max_pages` cap was hit while paginating. There may be older
  tweets you haven't seen yet. Re-call with the same arguments later (the
  cursor advances) to keep walking, or pass a smaller `since_iso`.

---

## Error patterns

| Error shape | Meaning | What to do |
|-------------|---------|------------|
| `{"error": "invalid_since_iso", ...}` | Your `since_iso` did not parse. | Send a valid ISO 8601 string. |
| `{"error": "invalid_id_or_url", ...}` | `x_get_tweet` could not extract a tweet ID. | Pass a numeric ID or a real `x.com/.../status/...` URL. |
| `{"error": "invalid_path", ...}` | `x_raw_get` path did not start with `/2/`. | Fix the path. |
| `{"error": "user_not_found", ...}` | Username does not resolve to an X user. | Don't retry. Tell the user. |
| `{"error": "not_found", ...}` | `x_get_tweet` for a tweet we have never seen and X says doesn't exist. | Don't retry. The tweet does not exist. |
| `{"error": "gate_blocked", "reason": "...", "next_eligible_at": "..."}` | The throttle gate is closed because of a prior error and there's nothing in cache. | Wait until `next_eligible_at`. |
| `{"error": "upstream_error", "status": N, ...}` | X returned an error and we have no cached fallback. | Surface the status; the proxy will retry per `error_retry_intervals`. |
| `{"verified": false, "reason": "gate_closed", "next_eligible_at": "..."}` | `x_verify_posts` was called within its 7d throttle window. | Don't retry. Use `x_posts_since` for routine checks. |

When you receive a `gate_blocked` or "verified": false response, **do not
loop**. The next eligible time is in the response — schedule a future call
or skip and tell the user.

---

## Tool input shapes (cheat sheet)

```jsonc
// 1. x_get_user_by_username
{ "username": "xdevelopers", "user.fields": "description,public_metrics" }

// 2. x_get_user_by_id
{ "user_id": "2244994945", "user.fields": "verified,created_at" }

// 3. x_get_tweet
{ "id_or_url": "https://x.com/xdevelopers/status/1854823981273648129",
  "tweet.fields": "created_at,public_metrics", "expansions": "author_id" }

// 4. x_raw_get  (use sparingly)
{ "path": "/2/spaces/search", "params": { "query": "AI", "max_results": 10 } }

// 5. x_posts_since   ★
{ "username": "xdevelopers", "since_iso": "2026-05-04T00:00:00Z",
  "max_pages": 5, "force_refresh": false }

// 6. x_follows_changes_since   ★
{ "username": "xdevelopers", "since_iso": "2026-04-28T00:00:00Z",
  "force_refresh": false }

// 7. x_verify_posts  (expensive)
{ "username": "xdevelopers", "since_iso": "2026-04-01T00:00:00Z" }
```

`user.fields`, `tweet.fields`, `expansions` follow the standard X API v2
field-expansion syntax: comma-separated names (e.g.
`"created_at,public_metrics,conversation_id"`).

---

## Tool output shapes (key fields you'll consume)

### `x_posts_since`

```jsonc
{
  "posts": [
    {
      "tweet_id": "1854823981273648129",
      "user_id": "2244994945",
      "text": "...",
      "created_at": "2026-05-05T10:42:18.421Z",
      "public_metrics": { "like_count": 12, "retweet_count": 3, "reply_count": 1, "quote_count": 0, "bookmark_count": 2, "impression_count": 1500 },
      "first_observed_at": "2026-05-05T10:43:00.000Z",
      "last_observed_at": "2026-05-05T11:00:00.000Z",
      "deleted": false,
      "deleted_at": null,
      "raw": { /* the original tweet JSON from X */ }
    }
    // ... ordered DESC by created_at, filtered to created_at >= since_iso
  ],
  "latest_observed_at": "2026-05-05T10:42:18.421Z",
  "touched_upstream": true,
  "truncated": false,
  "gate": {
    "last_fetched_at": "2026-05-05T11:00:00.000Z",
    "next_eligible_at": "2026-05-05T12:00:00.000Z"
  }
}
```

### `x_follows_changes_since`

```jsonc
{
  "new_follows":   [{ "user_id": "111", "username": "alice", "name": "Alice" }],
  "unfollows":     [{ "user_id": "222", "username": "bob",   "name": "Bob"   }],
  "baseline_snapshot_at":  "2026-04-28T03:00:00.000Z",
  "latest_snapshot_at":    "2026-05-05T03:00:00.000Z",
  "latest_walk_kind":      "partial",        // or "complete"
  "unfollows_may_be_stale": true,            // true when latest_walk_kind === "partial"
  "since_iso_requested":   "2026-04-28T00:00:00Z",
  "first_observation":     false,
  "touched_upstream":      true,
  "precision_note":        "Snapshots are taken on the get_user_following throttle cadence...",
  "gate": { "last_fetched_at": "...", "next_eligible_at": "..." }
}
```

### `x_get_tweet`

```jsonc
{
  "raw":   { /* the X API JSON, or null if served from a deletion-marked cache */ },
  "deleted": false,
  "deleted_at": null,
  "cached_record": { /* same shape as a post in x_posts_since.posts[] */ }
}
```

If `deleted: true`, `raw` may still contain the last-known data. Trust
`cached_record` for the canonical fields.

### `x_verify_posts`

```jsonc
{
  "verified": true,
  "checked": 350,
  "newly_deleted": 4,
  "refreshed": 346,
  "batches": 4
}
```

If `verified: false`, look at `reason` (`gate_closed` is the common one)
and `next_eligible_at`.

---

## Recommended workflows

### Periodically check what someone has posted since the last poll

```
while user wants live updates:
    let result = x_posts_since(username, since_iso = last_seen_iso or initial_window)
    if result.touched_upstream:
        process result.posts
        last_seen_iso = result.latest_observed_at
    else:
        // proxy served from cache; nothing new since last refresh
        pass
    sleep until result.gate.next_eligible_at
```

You can call `x_posts_since` more often than `next_eligible_at` if you
want — the proxy will just return the same cached data. The throttle
protects upstream quota, not your event loop.

### Detect new follows/unfollows once a day

```
let result = x_follows_changes_since(username, since_iso = 24h_ago_iso)
if result.first_observation:
    // first time observing — record the baseline silently, don't claim "new follows"
else:
    surface result.new_follows and result.unfollows
    surface result.precision_note if precision matters
```

### Confirm a specific tweet is still live before quoting

```
let t = x_get_tweet(id_or_url = "...")
if t.deleted:
    annotate the quote as "[deleted]" using t.cached_record.text
else:
    quote t.raw.data.text directly
```

### Look up a user once

```
let u = x_get_user_by_username(username = "...")
// the result is cached for 7 days. Repeated calls cost zero.
```

---

## Things you should not do

- Do not store the bearer token, ask for it, or pass it back to the user.
  The proxy holds it; you never touch it.
- Do not interpret a `gate_blocked` or `verified: false` response as
  "retry now." Wait until `next_eligible_at`, or skip.
- Do not paginate manually. `x_posts_since` and `x_follows_changes_since`
  walk pagination internally up to `max_pages` (or 100 for follow snapshots).
- Do not assume cached data is "stale" just because it's old. The proxy
  cache has no TTL by design. Whether to refresh upstream is the proxy's
  decision via the throttle gate, not yours.
- Do not try to write to X. There are no tools for it; if asked, tell the
  user this proxy is read-only.

---

## Quick reference: which signal answers which question?

| Question you might ask | Signal to read |
|------------------------|----------------|
| Did this call cost upstream quota? | `touched_upstream` |
| When can I get fresher data? | `gate.next_eligible_at` |
| Is this tweet still live on X? | `deleted` / `deleted_at` |
| Are these "new follows" actually new, or first-time baseline? | `first_observation` |
| Did I miss older tweets in this fetch? | `truncated` |
| Why did the proxy return nothing? | `error` plus `reason` and/or `next_eligible_at` |

When in doubt, read these fields *first* — they tell you the cost and
freshness of the response and dictate what to do next.
