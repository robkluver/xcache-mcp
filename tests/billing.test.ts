import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb, getDb } from "../src/cache.ts";
import {
  classifyEndpoint,
  computeCostUsd,
  currentPeriodStart,
  getOwnerUserId,
  getPeriodSnapshot,
  isOwned,
  ratePerResourceUsd,
  recordCostForEvent,
  recordUpstreamBilling,
  setOwnerUserId,
} from "../src/billing.ts";
import type { BillingConfig, BillingRates } from "../src/config.ts";

const RATES: BillingRates = {
  owned_read: 0.001,
  post_read: 0.005,
  user_read: 0.01,
  following_read: 0.01,
  list_read: 0.005,
  default_read: 0.005,
};

const CFG: BillingConfig = {
  enabled: true,
  period_start_day: 1,
  period_start_time: "00:00",
  rates: RATES,
};

let dbPath: string;

before(() => {
  dbPath = path.join(os.tmpdir(), `xcache-billing-test-${Date.now()}-${Math.random()}.db`);
  openDb(dbPath);
});

after(() => {
  closeDb();
});

beforeEach(() => {
  const d = getDb();
  d.prepare("DELETE FROM proxy_meta").run();
});

describe("classifyEndpoint", () => {
  test("maps following/followers", () => {
    assert.equal(classifyEndpoint("/2/users/123/following"), "following_read");
    assert.equal(classifyEndpoint("/2/users/123/followers"), "following_read");
  });
  test("maps user post-history endpoints", () => {
    assert.equal(classifyEndpoint("/2/users/123/tweets"), "post_read");
    assert.equal(classifyEndpoint("/2/users/123/mentions"), "post_read");
    assert.equal(classifyEndpoint("/2/users/123/liked_tweets"), "post_read");
    assert.equal(classifyEndpoint("/2/users/123/bookmarks"), "post_read");
  });
  test("maps tweets endpoints", () => {
    assert.equal(classifyEndpoint("/2/tweets"), "post_read");
    assert.equal(classifyEndpoint("/2/tweets/123"), "post_read");
    assert.equal(classifyEndpoint("/2/tweets/123/retweeted_by"), "post_read");
    assert.equal(classifyEndpoint("/2/tweets/123/liking_users"), "post_read");
    assert.equal(classifyEndpoint("/2/tweets/123/quote_tweets"), "post_read");
  });
  test("maps user list endpoints", () => {
    assert.equal(classifyEndpoint("/2/users/123/owned_lists"), "list_read");
    assert.equal(classifyEndpoint("/2/users/123/followed_lists"), "list_read");
    assert.equal(classifyEndpoint("/2/users/123/list_memberships"), "list_read");
    assert.equal(classifyEndpoint("/2/users/123/pinned_lists"), "list_read");
    assert.equal(classifyEndpoint("/2/lists/123"), "list_read");
  });
  test("maps user-by endpoints", () => {
    assert.equal(classifyEndpoint("/2/users"), "user_read");
    assert.equal(classifyEndpoint("/2/users/123"), "user_read");
    assert.equal(classifyEndpoint("/2/users/by/username/foo"), "user_read");
    assert.equal(classifyEndpoint("/2/users/me"), "user_read");
  });
  test("falls back to default_read", () => {
    assert.equal(classifyEndpoint(null), "default_read");
    assert.equal(classifyEndpoint("/2/something/else"), "default_read");
  });
});

describe("isOwned + ratePerResourceUsd", () => {
  test("isOwned matches account_id to owner_user_id", () => {
    assert.equal(isOwned("123", "123"), true);
    assert.equal(isOwned("123", "456"), false);
    assert.equal(isOwned(null, "123"), false);
    assert.equal(isOwned("123", null), false);
  });
  test("owned reads use owned_read rate regardless of endpoint kind", () => {
    const r = ratePerResourceUsd({
      endpointTemplate: "/2/users/123/following",
      accountId: "123",
      ownerUserId: "123",
      rates: RATES,
    });
    assert.equal(r, 0.001);
  });
  test("non-owned reads use the per-resource rate", () => {
    const r = ratePerResourceUsd({
      endpointTemplate: "/2/users/456/following",
      accountId: "456",
      ownerUserId: "123",
      rates: RATES,
    });
    assert.equal(r, 0.01);
  });
});

describe("computeCostUsd", () => {
  test("non-live source is free", () => {
    assert.equal(
      computeCostUsd({
        source: "cache",
        status: 200,
        resultCount: 5,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0,
    );
    assert.equal(
      computeCostUsd({
        source: "gate_blocked",
        status: 0,
        resultCount: 5,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0,
    );
    assert.equal(
      computeCostUsd({
        source: "error",
        status: 500,
        resultCount: 5,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0,
    );
  });
  test("non-2xx status is free", () => {
    assert.equal(
      computeCostUsd({
        source: "live",
        status: 429,
        resultCount: 5,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0,
    );
  });
  test("zero result_count is free", () => {
    assert.equal(
      computeCostUsd({
        source: "live",
        status: 200,
        resultCount: 0,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0,
    );
    assert.equal(
      computeCostUsd({
        source: "live",
        status: 200,
        resultCount: null,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0,
    );
  });
  test("billable: posts 5 × 0.005 = 0.025", () => {
    assert.equal(
      computeCostUsd({
        source: "live",
        status: 200,
        resultCount: 5,
        endpointTemplate: "/2/users/1/tweets",
        accountId: "1",
        ownerUserId: "9",
        rates: RATES,
      }),
      0.025,
    );
  });
  test("billable: owned reads at 0.001", () => {
    assert.equal(
      computeCostUsd({
        source: "live",
        status: 200,
        resultCount: 7,
        endpointTemplate: "/2/users/9/tweets",
        accountId: "9",
        ownerUserId: "9",
        rates: RATES,
      }),
      0.007,
    );
  });
});

describe("currentPeriodStart", () => {
  test("anchor day this month, anchor before now → returns this month", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    const start = currentPeriodStart(now, 1, "00:00");
    assert.equal(start.toISOString(), "2026-05-01T00:00:00.000Z");
  });
  test("anchor day this month, anchor after now → rolls back one month", () => {
    const now = new Date(Date.UTC(2026, 4, 5, 12, 0, 0));
    const start = currentPeriodStart(now, 15, "00:00");
    assert.equal(start.toISOString(), "2026-04-15T00:00:00.000Z");
  });
  test("rollback across year boundary", () => {
    const now = new Date(Date.UTC(2026, 0, 5, 0, 0, 0));
    const start = currentPeriodStart(now, 15, "00:00");
    assert.equal(start.toISOString(), "2025-12-15T00:00:00.000Z");
  });
  test("day=31 floors to last day of 30-day month", () => {
    const now = new Date(Date.UTC(2026, 3, 30, 23, 59, 0)); // April 30
    const start = currentPeriodStart(now, 31, "00:00");
    assert.equal(start.toISOString(), "2026-04-30T00:00:00.000Z");
  });
  test("day=31 floors to Feb 28 in non-leap year", () => {
    const now = new Date(Date.UTC(2026, 1, 28, 23, 59, 0));
    const start = currentPeriodStart(now, 31, "00:00");
    assert.equal(start.toISOString(), "2026-02-28T00:00:00.000Z");
  });
  test("HH:MM time is honored", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 14, 30, 0));
    const start = currentPeriodStart(now, 1, "08:15");
    assert.equal(start.toISOString(), "2026-05-01T08:15:00.000Z");
  });
});

describe("recordUpstreamBilling + getPeriodSnapshot", () => {
  test("first record initializes period and accumulates", () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    const r1 = recordUpstreamBilling(0.005, CFG, now);
    assert.equal(r1.period_total_usd, 0.005);
    assert.equal(r1.period_started_iso, "2026-05-01T00:00:00.000Z");

    const r2 = recordUpstreamBilling(0.002, CFG, now + 60_000);
    assert.equal(r2.period_total_usd, 0.007);
  });

  test("rollover when stored period_start is older than current period start", () => {
    const apr = Date.UTC(2026, 3, 10, 12, 0, 0);
    recordUpstreamBilling(0.005, CFG, apr);

    const may = Date.UTC(2026, 4, 2, 12, 0, 0);
    const r = recordUpstreamBilling(0.001, CFG, may);
    assert.equal(r.period_total_usd, 0.001);
    assert.equal(r.period_started_iso, "2026-05-01T00:00:00.000Z");
  });

  test("getPeriodSnapshot reflects rollover even without writes", () => {
    const apr = Date.UTC(2026, 3, 10, 12, 0, 0);
    recordUpstreamBilling(0.005, CFG, apr);
    const may = Date.UTC(2026, 4, 2, 12, 0, 0);
    const snap = getPeriodSnapshot(CFG, may);
    assert.equal(snap.period_total_usd, 0);
    assert.equal(snap.period_started_iso, "2026-05-01T00:00:00.000Z");
  });

  test("disabled cfg returns zeros and does not write", () => {
    const cfg: BillingConfig = { ...CFG, enabled: false };
    const r = recordUpstreamBilling(0.005, cfg);
    assert.equal(r.period_total_usd, 0);
    const row = getDb()
      .prepare("SELECT value FROM proxy_meta WHERE key = ?")
      .get("billing_period_total_micros");
    assert.equal(row, undefined);
  });

  test("integer micros precision: 1234 × 0.001 = 1.234 exact", () => {
    let total = 0;
    for (let i = 0; i < 1234; i++) {
      total = recordUpstreamBilling(0.001, CFG).period_total_usd;
    }
    assert.equal(total, 1.234);
  });
});

describe("recordCostForEvent", () => {
  test("non-billable events return cost=0 and don't increment", () => {
    const before = getPeriodSnapshot(CFG);
    const r = recordCostForEvent({
      source: "cache",
      status: 200,
      resultCount: 5,
      endpointTemplate: "/2/users/1/tweets",
      accountId: "1",
      cfg: CFG,
      ownerUserId: "9",
    });
    assert.equal(r.cost_usd, 0);
    const after = getPeriodSnapshot(CFG);
    assert.equal(after.period_total_usd, before.period_total_usd);
  });

  test("billable events increment period total", () => {
    const r = recordCostForEvent({
      source: "live",
      status: 200,
      resultCount: 4,
      endpointTemplate: "/2/users/1/tweets",
      accountId: "1",
      cfg: CFG,
      ownerUserId: "9",
    });
    assert.equal(r.cost_usd, 0.02);
    assert.equal(r.period_total_usd, 0.02);
  });
});

describe("owner_user_id storage", () => {
  test("getOwnerUserId returns null when unset", () => {
    assert.equal(getOwnerUserId(), null);
  });
  test("setOwnerUserId persists and getOwnerUserId returns it", () => {
    setOwnerUserId("987654321");
    assert.equal(getOwnerUserId(), "987654321");
  });
});
