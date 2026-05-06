import Database from "better-sqlite3";
import * as crypto from "node:crypto";

let db: Database.Database | null = null;

export function openDb(dbPath: string): Database.Database {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  bootstrapSchema(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not opened");
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
}

const SCHEMA_VERSION = 3;

/** Apply incremental migrations to bring an existing DB up to SCHEMA_VERSION.
 *  The CREATE TABLE IF NOT EXISTS calls in bootstrapSchema cover fresh DBs;
 *  this function handles existing DBs that pre-date a column addition. */
function runMigrations(d: Database.Database, fromVersion: number): void {
  if (fromVersion < 2) {
    // v2: add walk_kind column to follow_snapshots
    const cols = d.prepare("PRAGMA table_info(follow_snapshots)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "walk_kind")) {
      d.exec("ALTER TABLE follow_snapshots ADD COLUMN walk_kind TEXT NOT NULL DEFAULT 'complete'");
    }
  }
  // v3: new following_history + following_state tables (covered by IF NOT EXISTS
  //     in bootstrapSchema, so no ALTER needed). The legacy follow_snapshots*
  //     tables are left intact for backward compatibility; they're unused by
  //     the new follows tool flow.
  if (fromVersion < 3) {
    // No-op; CREATE TABLE IF NOT EXISTS in bootstrapSchema handles it.
  }
}

function bootstrapSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS url_cache (
      key TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status INTEGER NOT NULL,
      headers TEXT NOT NULL,
      body TEXT NOT NULL,
      first_fetched_at INTEGER NOT NULL,
      last_fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fetch_gate (
      operation TEXT NOT NULL,
      account_id TEXT NOT NULL,
      last_fetched_at INTEGER NOT NULL,
      last_status INTEGER,
      last_error TEXT,
      PRIMARY KEY (operation, account_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      tweet_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      conversation_id TEXT,
      in_reply_to_user_id TEXT,
      lang TEXT,
      possibly_sensitive INTEGER,
      retweet_count INTEGER,
      reply_count INTEGER,
      like_count INTEGER,
      quote_count INTEGER,
      bookmark_count INTEGER,
      impression_count INTEGER,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      deleted_at INTEGER,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_user_created
      ON posts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS posts_deleted
      ON posts(deleted_at) WHERE deleted_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS post_cursors (
      user_id TEXT PRIMARY KEY,
      latest_tweet_id_seen TEXT,
      latest_tweet_created_at INTEGER,
      oldest_tweet_id_seen TEXT,
      oldest_tweet_created_at INTEGER,
      total_observed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS follow_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      follow_count INTEGER NOT NULL,
      api_calls INTEGER NOT NULL,
      api_duration_ms INTEGER NOT NULL,
      walk_kind TEXT NOT NULL DEFAULT 'complete'
    );
    CREATE INDEX IF NOT EXISTS follow_snapshots_user_taken
      ON follow_snapshots(user_id, taken_at);

    CREATE TABLE IF NOT EXISTS follow_snapshot_members (
      snapshot_id INTEGER NOT NULL REFERENCES follow_snapshots(id) ON DELETE CASCADE,
      followed_user_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, followed_user_id)
    );
    CREATE INDEX IF NOT EXISTS follow_snapshot_members_user
      ON follow_snapshot_members(followed_user_id);

    CREATE TABLE IF NOT EXISTS follow_user_details (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      name TEXT,
      description TEXT,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL
    );

    -- v3: per-pair follow history + per-follower walk state.
    -- Replaces the snapshot-diff model with a continuous-walk model that
    -- always checks page 1 for new follows and incrementally backfills
    -- older pages from a persisted pagination token.
    CREATE TABLE IF NOT EXISTS following_history (
      follower_user_id   TEXT NOT NULL,
      followed_user_id   TEXT NOT NULL,
      first_observed_at  INTEGER NOT NULL,
      first_observed_via TEXT NOT NULL,        -- 'forward' | 'backfill' (future: 'audit')
      last_observed_at   INTEGER NOT NULL,
      PRIMARY KEY (follower_user_id, followed_user_id)
    );
    CREATE INDEX IF NOT EXISTS following_history_by_follower
      ON following_history(follower_user_id, first_observed_at DESC);

    CREATE TABLE IF NOT EXISTS following_state (
      follower_user_id      TEXT PRIMARY KEY,
      next_pagination_token TEXT,
      caught_up             INTEGER NOT NULL DEFAULT 0,
      last_walked_at        INTEGER
    );

    CREATE TABLE IF NOT EXISTS proxy_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const row = d.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  if (current < SCHEMA_VERSION) {
    runMigrations(d, current);
    d.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      SCHEMA_VERSION,
      Date.now(),
    );
  }
}

// ---------- url_cache helpers ----------

export function canonicalUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined> | URLSearchParams,
): string {
  const u = new URL(path.startsWith("http") ? path : base + path);
  // If incoming path already has a query string, those are part of u.searchParams.
  // We'll merge `params` over them (params win on conflict).
  if (params) {
    if (params instanceof URLSearchParams) {
      for (const [k, v] of params) {
        u.searchParams.set(k, v);
      }
    } else {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }
  }
  // Sort search params for canonicalization
  const entries = Array.from(u.searchParams.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  u.search = "";
  for (const [k, v] of entries) {
    u.searchParams.append(k, v);
  }
  return u.toString();
}

export function urlCacheKey(method: string, canonical: string): string {
  return `${method.toUpperCase()} ${canonical}`;
}

export type UrlCacheRow = {
  key: string;
  method: string;
  url: string;
  status: number;
  headers: string;
  body: string;
  first_fetched_at: number;
  last_fetched_at: number;
};

export function getUrlCache(key: string): UrlCacheRow | undefined {
  return getDb().prepare("SELECT * FROM url_cache WHERE key = ?").get(key) as
    | UrlCacheRow
    | undefined;
}

export function putUrlCache(args: {
  key: string;
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}): void {
  const now = Date.now();
  const row = getUrlCache(args.key);
  const headersJson = JSON.stringify(args.headers);
  if (row) {
    getDb()
      .prepare(
        `UPDATE url_cache SET method=?, url=?, status=?, headers=?, body=?, last_fetched_at=? WHERE key=?`,
      )
      .run(args.method, args.url, args.status, headersJson, args.body, now, args.key);
  } else {
    getDb()
      .prepare(
        `INSERT INTO url_cache (key, method, url, status, headers, body, first_fetched_at, last_fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(args.key, args.method, args.url, args.status, headersJson, args.body, now, now);
  }
}

// ---------- proxy_meta helpers ----------

export function metaIncrement(key: string, by: number): void {
  const now = Date.now();
  const row = getDb().prepare("SELECT value FROM proxy_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  const next = current + by;
  if (row) {
    getDb()
      .prepare("UPDATE proxy_meta SET value = ?, updated_at = ? WHERE key = ?")
      .run(String(next), now, key);
  } else {
    getDb()
      .prepare("INSERT INTO proxy_meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, String(next), now);
  }
}

// ---------- fingerprinting (used by raw_get and logging) ----------

export function queryFingerprint(
  endpointTemplate: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  // Strip pagination params for fingerprint (they vary per-page within a chain)
  const PAGINATION_KEYS = new Set(["pagination_token", "next_token", "cursor"]);
  const entries = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== null && !PAGINATION_KEYS.has(k))
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canon = `${endpointTemplate}|${entries.map(([k, v]) => `${k}=${v}`).join("&")}`;
  const h = crypto.createHash("sha256").update(canon).digest("hex").slice(0, 8);
  return `fp_${h}`;
}

export function shaFingerprint(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join(" ")).digest("hex");
}

// ---------- posts helpers ----------

export type PostRow = {
  tweet_id: string;
  user_id: string;
  text: string;
  created_at: number;
  conversation_id: string | null;
  in_reply_to_user_id: string | null;
  lang: string | null;
  possibly_sensitive: number | null;
  retweet_count: number | null;
  reply_count: number | null;
  like_count: number | null;
  quote_count: number | null;
  bookmark_count: number | null;
  impression_count: number | null;
  first_observed_at: number;
  last_observed_at: number;
  deleted_at: number | null;
  raw_json: string;
};

export function upsertPost(
  p: Omit<PostRow, "first_observed_at" | "last_observed_at"> & {
    observed_at: number;
  },
): void {
  const existing = getDb()
    .prepare("SELECT first_observed_at, deleted_at FROM posts WHERE tweet_id = ?")
    .get(p.tweet_id) as { first_observed_at: number; deleted_at: number | null } | undefined;
  if (existing) {
    getDb()
      .prepare(
        `UPDATE posts SET
           text = ?, created_at = ?, conversation_id = ?, in_reply_to_user_id = ?,
           lang = ?, possibly_sensitive = ?, retweet_count = ?, reply_count = ?,
           like_count = ?, quote_count = ?, bookmark_count = ?, impression_count = ?,
           last_observed_at = ?, raw_json = ?
         WHERE tweet_id = ?`,
      )
      .run(
        p.text,
        p.created_at,
        p.conversation_id,
        p.in_reply_to_user_id,
        p.lang,
        p.possibly_sensitive,
        p.retweet_count,
        p.reply_count,
        p.like_count,
        p.quote_count,
        p.bookmark_count,
        p.impression_count,
        p.observed_at,
        p.raw_json,
        p.tweet_id,
      );
  } else {
    getDb()
      .prepare(
        `INSERT INTO posts (
           tweet_id, user_id, text, created_at, conversation_id, in_reply_to_user_id,
           lang, possibly_sensitive, retweet_count, reply_count, like_count,
           quote_count, bookmark_count, impression_count,
           first_observed_at, last_observed_at, deleted_at, raw_json
         )
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.tweet_id,
        p.user_id,
        p.text,
        p.created_at,
        p.conversation_id,
        p.in_reply_to_user_id,
        p.lang,
        p.possibly_sensitive,
        p.retweet_count,
        p.reply_count,
        p.like_count,
        p.quote_count,
        p.bookmark_count,
        p.impression_count,
        p.observed_at,
        p.observed_at,
        p.deleted_at,
        p.raw_json,
      );
  }
}

export function markPostDeleted(tweet_id: string, when: number): boolean {
  const res = getDb()
    .prepare(
      "UPDATE posts SET deleted_at = ?, last_observed_at = ? WHERE tweet_id = ? AND deleted_at IS NULL",
    )
    .run(when, when, tweet_id);
  return (res.changes ?? 0) > 0;
}

export function getPost(tweet_id: string): PostRow | undefined {
  return getDb().prepare("SELECT * FROM posts WHERE tweet_id = ?").get(tweet_id) as
    | PostRow
    | undefined;
}

export function postsSince(user_id: string, since_ms: number): PostRow[] {
  return getDb()
    .prepare("SELECT * FROM posts WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC")
    .all(user_id, since_ms) as PostRow[];
}

export function liveTweetIdsSince(user_id: string, since_ms: number): string[] {
  return (
    getDb()
      .prepare(
        "SELECT tweet_id FROM posts WHERE user_id = ? AND created_at >= ? AND deleted_at IS NULL",
      )
      .all(user_id, since_ms) as { tweet_id: string }[]
  ).map((r) => r.tweet_id);
}

// ---------- post cursors ----------

export type PostCursorRow = {
  user_id: string;
  latest_tweet_id_seen: string | null;
  latest_tweet_created_at: number | null;
  oldest_tweet_id_seen: string | null;
  oldest_tweet_created_at: number | null;
  total_observed: number;
};

export function getPostCursor(user_id: string): PostCursorRow | undefined {
  return getDb().prepare("SELECT * FROM post_cursors WHERE user_id = ?").get(user_id) as
    | PostCursorRow
    | undefined;
}

export function upsertPostCursor(args: {
  user_id: string;
  latest_tweet_id?: string | null;
  latest_tweet_created_at?: number | null;
  oldest_tweet_id?: string | null;
  oldest_tweet_created_at?: number | null;
  added_observations?: number;
}): void {
  const row = getPostCursor(args.user_id);
  if (!row) {
    getDb()
      .prepare(
        `INSERT INTO post_cursors (user_id, latest_tweet_id_seen, latest_tweet_created_at,
           oldest_tweet_id_seen, oldest_tweet_created_at, total_observed)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.user_id,
        args.latest_tweet_id ?? null,
        args.latest_tweet_created_at ?? null,
        args.oldest_tweet_id ?? null,
        args.oldest_tweet_created_at ?? null,
        args.added_observations ?? 0,
      );
    return;
  }
  let latestId = row.latest_tweet_id_seen;
  let latestAt = row.latest_tweet_created_at;
  if (
    args.latest_tweet_created_at != null &&
    (latestAt == null || args.latest_tweet_created_at > latestAt)
  ) {
    latestId = args.latest_tweet_id ?? latestId;
    latestAt = args.latest_tweet_created_at;
  }
  let oldestId = row.oldest_tweet_id_seen;
  let oldestAt = row.oldest_tweet_created_at;
  if (
    args.oldest_tweet_created_at != null &&
    (oldestAt == null || args.oldest_tweet_created_at < oldestAt)
  ) {
    oldestId = args.oldest_tweet_id ?? oldestId;
    oldestAt = args.oldest_tweet_created_at;
  }
  const total = row.total_observed + (args.added_observations ?? 0);
  getDb()
    .prepare(
      `UPDATE post_cursors SET
         latest_tweet_id_seen = ?, latest_tweet_created_at = ?,
         oldest_tweet_id_seen = ?, oldest_tweet_created_at = ?,
         total_observed = ?
       WHERE user_id = ?`,
    )
    .run(latestId, latestAt, oldestId, oldestAt, total, args.user_id);
}

// ---------- follow snapshots ----------

export type FollowSnapshotWalkKind = "complete" | "partial";

export type FollowSnapshotRow = {
  id: number;
  user_id: string;
  taken_at: number;
  follow_count: number;
  api_calls: number;
  api_duration_ms: number;
  walk_kind: FollowSnapshotWalkKind;
};

export function insertFollowSnapshot(args: {
  user_id: string;
  taken_at: number;
  members: string[];
  api_calls: number;
  api_duration_ms: number;
  walk_kind: FollowSnapshotWalkKind;
  details: Array<{
    user_id: string;
    username?: string | null;
    name?: string | null;
    description?: string | null;
    raw: object;
  }>;
}): number {
  const d = getDb();
  const txn = d.transaction(() => {
    const res = d
      .prepare(
        `INSERT INTO follow_snapshots (user_id, taken_at, follow_count, api_calls, api_duration_ms, walk_kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.user_id,
        args.taken_at,
        args.members.length,
        args.api_calls,
        args.api_duration_ms,
        args.walk_kind,
      );
    const snapshotId = Number(res.lastInsertRowid);
    const memberStmt = d.prepare(
      "INSERT OR IGNORE INTO follow_snapshot_members (snapshot_id, followed_user_id) VALUES (?, ?)",
    );
    for (const m of args.members) {
      memberStmt.run(snapshotId, m);
    }
    const detailStmt = d.prepare(
      `INSERT INTO follow_user_details (user_id, username, name, description, fetched_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         name = excluded.name,
         description = excluded.description,
         fetched_at = excluded.fetched_at,
         raw_json = excluded.raw_json`,
    );
    for (const det of args.details) {
      detailStmt.run(
        det.user_id,
        det.username ?? null,
        det.name ?? null,
        det.description ?? null,
        args.taken_at,
        JSON.stringify(det.raw),
      );
    }
    return snapshotId;
  });
  return txn();
}

export function latestSnapshotForUser(user_id: string): FollowSnapshotRow | undefined {
  return getDb()
    .prepare("SELECT * FROM follow_snapshots WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1")
    .get(user_id) as FollowSnapshotRow | undefined;
}

export function snapshotAtOrBefore(user_id: string, ts: number): FollowSnapshotRow | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM follow_snapshots WHERE user_id = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1",
    )
    .get(user_id, ts) as FollowSnapshotRow | undefined;
}

export function snapshotMemberIds(snapshot_id: number): string[] {
  return (
    getDb()
      .prepare("SELECT followed_user_id FROM follow_snapshot_members WHERE snapshot_id = ?")
      .all(snapshot_id) as { followed_user_id: string }[]
  ).map((r) => r.followed_user_id);
}

export type FollowUserDetailRow = {
  user_id: string;
  username: string | null;
  name: string | null;
  description: string | null;
  fetched_at: number;
  raw_json: string;
};

export function getFollowUserDetails(ids: string[]): FollowUserDetailRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM follow_user_details WHERE user_id IN (${placeholders})`)
    .all(...ids) as FollowUserDetailRow[];
}

// ---------- following_history + following_state (Reading B model) ----------

export type FollowingObservationVia = "forward" | "backfill";

export type FollowingHistoryRow = {
  follower_user_id: string;
  followed_user_id: string;
  first_observed_at: number;
  first_observed_via: FollowingObservationVia;
  last_observed_at: number;
};

export type FollowingStateRow = {
  follower_user_id: string;
  next_pagination_token: string | null;
  caught_up: number;
  last_walked_at: number | null;
};

/** Insert a new (follower, followed) observation, or refresh last_observed_at on
 *  an existing pair. Preserves first_observed_at and first_observed_via on
 *  conflict — the moment we first saw a pair is immutable. */
export function upsertFollowingObservation(args: {
  follower_user_id: string;
  followed_user_id: string;
  via: FollowingObservationVia;
  observed_at: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO following_history (
         follower_user_id, followed_user_id,
         first_observed_at, first_observed_via,
         last_observed_at
       )
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(follower_user_id, followed_user_id) DO UPDATE SET
         last_observed_at = excluded.last_observed_at`,
    )
    .run(
      args.follower_user_id,
      args.followed_user_id,
      args.observed_at,
      args.via,
      args.observed_at,
    );
}

export function getFollowingHistory(follower_user_id: string): FollowingHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM following_history
       WHERE follower_user_id = ?
       ORDER BY first_observed_at DESC`,
    )
    .all(follower_user_id) as FollowingHistoryRow[];
}

export function followedUserIdsForFollower(follower_user_id: string): Set<string> {
  const rows = getDb()
    .prepare(`SELECT followed_user_id FROM following_history WHERE follower_user_id = ?`)
    .all(follower_user_id) as { followed_user_id: string }[];
  return new Set(rows.map((r) => r.followed_user_id));
}

export function getFollowingState(follower_user_id: string): FollowingStateRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM following_state WHERE follower_user_id = ?`)
    .get(follower_user_id) as FollowingStateRow | undefined;
}

export function setFollowingState(args: {
  follower_user_id: string;
  next_pagination_token: string | null;
  caught_up: boolean;
  last_walked_at: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO following_state (
         follower_user_id, next_pagination_token, caught_up, last_walked_at
       )
       VALUES (?, ?, ?, ?)
       ON CONFLICT(follower_user_id) DO UPDATE SET
         next_pagination_token = excluded.next_pagination_token,
         caught_up = excluded.caught_up,
         last_walked_at = excluded.last_walked_at`,
    )
    .run(
      args.follower_user_id,
      args.next_pagination_token,
      args.caught_up ? 1 : 0,
      args.last_walked_at,
    );
}
