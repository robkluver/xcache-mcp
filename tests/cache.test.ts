import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  openDb,
  closeDb,
  canonicalUrl,
  queryFingerprint,
  shaFingerprint,
  putUrlCache,
  getUrlCache,
  urlCacheKey,
  upsertPost,
  getPost,
  markPostDeleted,
  postsSince,
  liveTweetIdsSince,
  upsertPostCursor,
  getPostCursor,
  insertFollowSnapshot,
  latestSnapshotForUser,
  snapshotAtOrBefore,
  snapshotMemberIds,
  getFollowUserDetails,
  metaIncrement,
  getDb,
} from "../src/cache.ts";

let dbPath: string;

before(() => {
  dbPath = path.join(os.tmpdir(), `xcache-cache-test-${Date.now()}-${Math.random()}.db`);
  openDb(dbPath);
});

after(() => {
  closeDb();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("canonicalUrl", () => {
  test("appends to base", () => {
    assert.equal(
      canonicalUrl("https://api.x.com", "/2/users", { id: "123" }),
      "https://api.x.com/2/users?id=123",
    );
  });
  test("sorts params alphabetically", () => {
    assert.equal(
      canonicalUrl("https://api.x.com", "/2/users", { c: "3", a: "1", b: "2" }),
      "https://api.x.com/2/users?a=1&b=2&c=3",
    );
  });
  test("merges path query with params", () => {
    assert.equal(
      canonicalUrl("https://api.x.com", "/2/users?z=9", { a: "1" }),
      "https://api.x.com/2/users?a=1&z=9",
    );
  });
  test("params override path query on conflict", () => {
    assert.equal(
      canonicalUrl("https://api.x.com", "/2/users?a=old", { a: "new" }),
      "https://api.x.com/2/users?a=new",
    );
  });
  test("skips undefined params", () => {
    assert.equal(
      canonicalUrl("https://api.x.com", "/2/u", { a: "1", b: undefined }),
      "https://api.x.com/2/u?a=1",
    );
  });
  test("no params", () => {
    assert.equal(canonicalUrl("https://api.x.com", "/2/u"), "https://api.x.com/2/u");
  });
  test("URLSearchParams input", () => {
    assert.equal(
      canonicalUrl(
        "https://api.x.com",
        "/2/u",
        new URLSearchParams([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
      "https://api.x.com/2/u?a=1&b=2",
    );
  });
});

describe("queryFingerprint", () => {
  test("starts with fp_", () => {
    assert.match(queryFingerprint("/2/x", {}), /^fp_[0-9a-f]{8}$/);
  });
  test("stable across param order", () => {
    const a = queryFingerprint("/2/x", { a: "1", b: "2" });
    const b = queryFingerprint("/2/x", { b: "2", a: "1" });
    assert.equal(a, b);
  });
  test("strips pagination_token, next_token, cursor", () => {
    const base = queryFingerprint("/2/x", { a: "1" });
    assert.equal(base, queryFingerprint("/2/x", { a: "1", pagination_token: "abc" }));
    assert.equal(base, queryFingerprint("/2/x", { a: "1", next_token: "xyz" }));
    assert.equal(base, queryFingerprint("/2/x", { a: "1", cursor: "qqq" }));
  });
  test("differs for different param values", () => {
    assert.notEqual(queryFingerprint("/2/x", { a: "1" }), queryFingerprint("/2/x", { a: "2" }));
  });
  test("differs for different endpoint templates", () => {
    assert.notEqual(queryFingerprint("/2/x", { a: "1" }), queryFingerprint("/2/y", { a: "1" }));
  });
});

describe("shaFingerprint", () => {
  test("returns a 64-char hex string", () => {
    assert.match(shaFingerprint("test"), /^[a-f0-9]{64}$/);
  });
  test("stable", () => {
    assert.equal(shaFingerprint("a", "b"), shaFingerprint("a", "b"));
  });
  test("ordered", () => {
    assert.notEqual(shaFingerprint("a", "b"), shaFingerprint("b", "a"));
  });
});

describe("url_cache", () => {
  test("put then get round-trips", () => {
    const key = urlCacheKey("GET", "https://x.com/test1");
    putUrlCache({
      key,
      method: "GET",
      url: "https://x.com/test1",
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"x":1}',
    });
    const row = getUrlCache(key);
    assert.ok(row);
    assert.equal(row!.status, 200);
    assert.equal(row!.body, '{"x":1}');
    const headers = JSON.parse(row!.headers);
    assert.equal(headers["content-type"], "application/json");
  });

  test("re-put updates last_fetched_at, preserves first_fetched_at", async () => {
    const key = urlCacheKey("GET", "https://x.com/test2");
    putUrlCache({
      key,
      method: "GET",
      url: "https://x.com/test2",
      status: 200,
      headers: {},
      body: "a",
    });
    const r1 = getUrlCache(key)!;
    await new Promise((r) => setTimeout(r, 5));
    putUrlCache({
      key,
      method: "GET",
      url: "https://x.com/test2",
      status: 200,
      headers: {},
      body: "b",
    });
    const r2 = getUrlCache(key)!;
    assert.equal(r2.first_fetched_at, r1.first_fetched_at);
    assert.ok(r2.last_fetched_at > r1.last_fetched_at);
    assert.equal(r2.body, "b");
  });

  test("get returns undefined for missing key", () => {
    assert.equal(getUrlCache("GET https://nope.example/notthere"), undefined);
  });
});

const POST_BASE = {
  conversation_id: null,
  in_reply_to_user_id: null,
  lang: null,
  possibly_sensitive: null,
  retweet_count: null,
  reply_count: null,
  like_count: null,
  quote_count: null,
  bookmark_count: null,
  impression_count: null,
  deleted_at: null,
  raw_json: "{}",
};

describe("posts upsert", () => {
  test("first insert sets first_observed_at and last_observed_at", () => {
    upsertPost({
      tweet_id: "P-100",
      user_id: "u1",
      text: "hello",
      created_at: 1000,
      ...POST_BASE,
      observed_at: 5000,
    });
    const r = getPost("P-100")!;
    assert.equal(r.first_observed_at, 5000);
    assert.equal(r.last_observed_at, 5000);
  });

  test("conflict preserves first_observed_at, updates metrics + last_observed_at", () => {
    upsertPost({
      tweet_id: "P-200",
      user_id: "u1",
      text: "hello",
      created_at: 1000,
      ...POST_BASE,
      retweet_count: 1,
      like_count: 5,
      observed_at: 5000,
    });
    const r1 = getPost("P-200")!;
    assert.equal(r1.like_count, 5);

    upsertPost({
      tweet_id: "P-200",
      user_id: "u1",
      text: "hello (mutated)",
      created_at: 1000,
      ...POST_BASE,
      retweet_count: 100,
      like_count: 50,
      observed_at: 6000,
    });
    const r2 = getPost("P-200")!;
    assert.equal(r2.first_observed_at, 5000); // preserved
    assert.equal(r2.last_observed_at, 6000); // updated
    assert.equal(r2.like_count, 50); // updated
    assert.equal(r2.retweet_count, 100);
    assert.equal(r2.text, "hello (mutated)");
  });

  test("conflict does NOT clear deleted_at", () => {
    upsertPost({
      tweet_id: "P-300",
      user_id: "u1",
      text: "x",
      created_at: 1,
      ...POST_BASE,
      observed_at: 10,
    });
    markPostDeleted("P-300", 20);
    upsertPost({
      tweet_id: "P-300",
      user_id: "u1",
      text: "x",
      created_at: 1,
      ...POST_BASE,
      observed_at: 30,
    });
    const r = getPost("P-300")!;
    assert.equal(r.deleted_at, 20);
  });
});

describe("markPostDeleted", () => {
  test("returns true the first time, false the second", () => {
    upsertPost({
      tweet_id: "P-400",
      user_id: "u1",
      text: "x",
      created_at: 1,
      ...POST_BASE,
      observed_at: 10,
    });
    assert.equal(markPostDeleted("P-400", 20), true);
    assert.equal(markPostDeleted("P-400", 30), false);
    const r = getPost("P-400")!;
    assert.equal(r.deleted_at, 20);
  });

  test("returns false for unknown tweet", () => {
    assert.equal(markPostDeleted("P-NEVER", 100), false);
  });
});

describe("postsSince and liveTweetIdsSince", () => {
  test("postsSince orders by created_at DESC and filters", () => {
    const u = "u-since";
    for (let i = 0; i < 5; i++) {
      upsertPost({
        tweet_id: `S-${i}`,
        user_id: u,
        text: `t${i}`,
        created_at: 1000 + i * 100,
        ...POST_BASE,
        observed_at: 9999,
      });
    }
    const all = postsSince(u, 0);
    assert.equal(all.length, 5);
    assert.equal(all[0]!.created_at, 1400);
    assert.equal(all[4]!.created_at, 1000);

    const partial = postsSince(u, 1200);
    assert.deepEqual(
      partial.map((p) => p.created_at),
      [1400, 1300, 1200],
    );
  });

  test("liveTweetIdsSince excludes deleted", () => {
    const u = "u-live";
    upsertPost({
      tweet_id: "L-1",
      user_id: u,
      text: "1",
      created_at: 1000,
      ...POST_BASE,
      observed_at: 1,
    });
    upsertPost({
      tweet_id: "L-2",
      user_id: u,
      text: "2",
      created_at: 1000,
      ...POST_BASE,
      observed_at: 1,
    });
    markPostDeleted("L-2", 100);
    const live = liveTweetIdsSince(u, 0);
    assert.deepEqual(live.sort(), ["L-1"]);
  });
});

describe("post cursors", () => {
  test("inserts new", () => {
    upsertPostCursor({
      user_id: "c1",
      latest_tweet_id: "10",
      latest_tweet_created_at: 1000,
      added_observations: 1,
    });
    const r = getPostCursor("c1")!;
    assert.equal(r.latest_tweet_id_seen, "10");
    assert.equal(r.latest_tweet_created_at, 1000);
    assert.equal(r.total_observed, 1);
  });

  test("latest cursor only moves forward", () => {
    upsertPostCursor({
      user_id: "c2",
      latest_tweet_id: "10",
      latest_tweet_created_at: 1000,
      added_observations: 1,
    });
    upsertPostCursor({
      user_id: "c2",
      latest_tweet_id: "5",
      latest_tweet_created_at: 500,
      added_observations: 2,
    });
    const r = getPostCursor("c2")!;
    assert.equal(r.latest_tweet_id_seen, "10"); // not regressed
    assert.equal(r.latest_tweet_created_at, 1000);
    assert.equal(r.total_observed, 3);
  });

  test("oldest cursor only moves backward", () => {
    upsertPostCursor({
      user_id: "c3",
      oldest_tweet_id: "10",
      oldest_tweet_created_at: 1000,
    });
    upsertPostCursor({
      user_id: "c3",
      oldest_tweet_id: "5",
      oldest_tweet_created_at: 500,
    });
    upsertPostCursor({
      user_id: "c3",
      oldest_tweet_id: "20",
      oldest_tweet_created_at: 2000,
    });
    const r = getPostCursor("c3")!;
    assert.equal(r.oldest_tweet_id_seen, "5"); // moves backward, not forward
  });

  test("missing user returns undefined", () => {
    assert.equal(getPostCursor("nonexistent"), undefined);
  });
});

describe("follow snapshots", () => {
  test("insert + member readback + details upsert", () => {
    const id = insertFollowSnapshot({
      user_id: "fu1",
      taken_at: 1000,
      members: ["a", "b", "c"],
      api_calls: 1,
      api_duration_ms: 50,
      walk_kind: "complete",
      details: [
        { user_id: "a", username: "alice", name: "Alice", description: "x", raw: { id: "a" } },
        { user_id: "b", username: "bob", name: "Bob", description: null, raw: { id: "b" } },
        { user_id: "c", username: null, name: null, raw: { id: "c" } },
      ],
    });
    assert.ok(id > 0);

    const members = snapshotMemberIds(id);
    assert.deepEqual(members.sort(), ["a", "b", "c"]);

    const dets = getFollowUserDetails(["a", "b", "c"]);
    assert.equal(dets.length, 3);
    const a = dets.find((d) => d.user_id === "a")!;
    assert.equal(a.username, "alice");
    assert.equal(a.name, "Alice");
  });

  test("snapshotAtOrBefore picks the latest <= ts; latestSnapshotForUser unbounded", () => {
    insertFollowSnapshot({
      user_id: "fu2",
      taken_at: 1000,
      members: [],
      api_calls: 0,
      api_duration_ms: 0,
      walk_kind: "complete",
      details: [],
    });
    insertFollowSnapshot({
      user_id: "fu2",
      taken_at: 2000,
      members: [],
      api_calls: 0,
      api_duration_ms: 0,
      walk_kind: "complete",
      details: [],
    });
    insertFollowSnapshot({
      user_id: "fu2",
      taken_at: 3000,
      members: [],
      api_calls: 0,
      api_duration_ms: 0,
      walk_kind: "complete",
      details: [],
    });
    const r = snapshotAtOrBefore("fu2", 2500)!;
    assert.equal(r.taken_at, 2000);
    assert.equal(snapshotAtOrBefore("fu2", 500), undefined);
    const latest = latestSnapshotForUser("fu2")!;
    assert.equal(latest.taken_at, 3000);
  });

  test("re-upsert details refreshes username/name", () => {
    insertFollowSnapshot({
      user_id: "fu3",
      taken_at: 1000,
      members: ["x"],
      api_calls: 0,
      api_duration_ms: 0,
      walk_kind: "complete",
      details: [{ user_id: "x", username: "old", name: "Old", raw: {} }],
    });
    insertFollowSnapshot({
      user_id: "fu3",
      taken_at: 2000,
      members: ["x"],
      api_calls: 0,
      api_duration_ms: 0,
      walk_kind: "complete",
      details: [{ user_id: "x", username: "new", name: "New", raw: {} }],
    });
    const dets = getFollowUserDetails(["x"]);
    assert.equal(dets[0]!.username, "new");
    assert.equal(dets[0]!.name, "New");
  });

  test("getFollowUserDetails empty input → empty output", () => {
    assert.deepEqual(getFollowUserDetails([]), []);
  });

  test("walk_kind round-trips on the snapshot row", () => {
    const idC = insertFollowSnapshot({
      user_id: "wk",
      taken_at: 100,
      members: ["a"],
      api_calls: 1,
      api_duration_ms: 1,
      walk_kind: "complete",
      details: [],
    });
    const idP = insertFollowSnapshot({
      user_id: "wk",
      taken_at: 200,
      members: ["a", "b"],
      api_calls: 1,
      api_duration_ms: 1,
      walk_kind: "partial",
      details: [],
    });
    void idC;
    const row = latestSnapshotForUser("wk")!;
    assert.equal(row.id, idP);
    assert.equal(row.walk_kind, "partial");
  });
});

describe("metaIncrement", () => {
  test("creates and increments cumulatively", () => {
    getDb().prepare("DELETE FROM proxy_meta WHERE key = ?").run("test_counter");
    metaIncrement("test_counter", 1);
    metaIncrement("test_counter", 5);
    metaIncrement("test_counter", 4);
    const row = getDb()
      .prepare("SELECT value FROM proxy_meta WHERE key = ?")
      .get("test_counter") as { value: string } | undefined;
    assert.equal(row?.value, "10");
  });
});
