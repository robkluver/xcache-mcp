import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb, type PostRow } from "../src/cache.ts";
import { extractTweetId, rowToPostRecord } from "../src/tools.ts";

let dbPath: string;

before(() => {
  // rowToPostRecord doesn't actually touch the DB, but importing tools.ts pulls in
  // cache.ts and gate.ts; opening a DB keeps later prepared-statement code happy if
  // someone extends these tests.
  dbPath = path.join(os.tmpdir(), `xcache-tools-test-${Date.now()}-${Math.random()}.db`);
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

describe("extractTweetId", () => {
  test("plain numeric id", () => {
    assert.equal(extractTweetId("1234567890"), "1234567890");
  });
  test("very long numeric id (snowflake)", () => {
    assert.equal(extractTweetId("1854823981273648129"), "1854823981273648129");
  });
  test("x.com URL", () => {
    assert.equal(extractTweetId("https://x.com/user/status/1234567890"), "1234567890");
  });
  test("twitter.com URL", () => {
    assert.equal(extractTweetId("https://twitter.com/user/status/9876543210"), "9876543210");
  });
  test("URL with query string", () => {
    assert.equal(extractTweetId("https://x.com/user/status/123?s=20&t=abc"), "123");
  });
  test("URL without scheme", () => {
    assert.equal(extractTweetId("x.com/user/status/42"), "42");
  });
  test("trims surrounding whitespace", () => {
    assert.equal(extractTweetId("  1234  "), "1234");
  });
  test("rejects mixed alphanumeric", () => {
    assert.equal(extractTweetId("12abc"), null);
    assert.equal(extractTweetId("abc12"), null);
  });
  test("rejects empty / non-tweet strings", () => {
    assert.equal(extractTweetId(""), null);
    assert.equal(extractTweetId("just-some-string"), null);
    assert.equal(extractTweetId("https://x.com/user"), null);
  });
});

describe("rowToPostRecord", () => {
  function row(overrides: Partial<PostRow> = {}): PostRow {
    return {
      tweet_id: "T1",
      user_id: "U1",
      text: "hello",
      created_at: 1_700_000_000_000,
      conversation_id: "C1",
      in_reply_to_user_id: null,
      lang: "en",
      possibly_sensitive: 0,
      retweet_count: 1,
      reply_count: 2,
      like_count: 3,
      quote_count: 4,
      bookmark_count: 5,
      impression_count: 6,
      first_observed_at: 1_700_000_000_000,
      last_observed_at: 1_700_000_001_000,
      deleted_at: null,
      raw_json: '{"id":"T1"}',
      ...overrides,
    };
  }

  test("converts ms epochs to ISO 8601", () => {
    const rec = rowToPostRecord(row()) as Record<string, unknown>;
    assert.equal(rec.tweet_id, "T1");
    assert.equal(rec.user_id, "U1");
    assert.equal(rec.text, "hello");
    assert.equal(rec.created_at, new Date(1_700_000_000_000).toISOString());
    assert.equal(rec.first_observed_at, new Date(1_700_000_000_000).toISOString());
    assert.equal(rec.last_observed_at, new Date(1_700_000_001_000).toISOString());
  });

  test("populates public_metrics when any metric is set", () => {
    const rec = rowToPostRecord(row()) as { public_metrics: Record<string, number> };
    assert.deepEqual(rec.public_metrics, {
      retweet_count: 1,
      reply_count: 2,
      like_count: 3,
      quote_count: 4,
      bookmark_count: 5,
      impression_count: 6,
    });
  });

  test("omits public_metrics when all are null", () => {
    const rec = rowToPostRecord(
      row({
        retweet_count: null,
        reply_count: null,
        like_count: null,
        quote_count: null,
        bookmark_count: null,
        impression_count: null,
      }),
    ) as Record<string, unknown>;
    assert.equal(rec.public_metrics, undefined);
  });

  test("deleted: false when deleted_at is null", () => {
    const rec = rowToPostRecord(row()) as Record<string, unknown>;
    assert.equal(rec.deleted, false);
    assert.equal(rec.deleted_at, null);
  });

  test("deleted: true and ISO deleted_at when set", () => {
    const rec = rowToPostRecord(row({ deleted_at: 1_700_000_005_000 })) as Record<string, unknown>;
    assert.equal(rec.deleted, true);
    assert.equal(rec.deleted_at, new Date(1_700_000_005_000).toISOString());
  });

  test("parses raw_json into raw object", () => {
    const rec = rowToPostRecord(row()) as { raw: { id: string } };
    assert.equal(rec.raw.id, "T1");
  });

  test("malformed raw_json sets raw to null", () => {
    const rec = rowToPostRecord(row({ raw_json: "{not json" })) as Record<string, unknown>;
    assert.equal(rec.raw, null);
  });

  test("undefined optional fields are omitted (not nulled)", () => {
    const rec = rowToPostRecord(
      row({ conversation_id: null, in_reply_to_user_id: null, lang: null }),
    ) as Record<string, unknown>;
    assert.ok(!("conversation_id" in rec));
    assert.ok(!("in_reply_to_user_id" in rec));
    assert.ok(!("lang" in rec));
  });
});
