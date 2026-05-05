import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb, getDb } from "../src/cache.ts";
import { loadAppFileConfig } from "../src/config.ts";
import {
  gateState,
  writeGateSuccess,
  writeGateError,
  readGate,
  nextEligibleIso,
  lastFetchedIso,
} from "../src/gate.ts";

let dbPath: string;
let configPath: string;

before(() => {
  dbPath = path.join(os.tmpdir(), `xcache-gate-test-${Date.now()}-${Math.random()}.db`);
  openDb(dbPath);
  configPath = path.join(os.tmpdir(), `app-config-gate-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      throttle: {
        default_min_interval: "1h",
        operations: {
          op_short: "30s",
          op_long: "1d",
          op_never: "never",
          op_always: "always",
        },
        error_retry_intervals: {
          "404": "10m",
          "5xx": "1m",
          "401": "never",
          network: "30s",
        },
      },
    }),
  );
  loadAppFileConfig(configPath);
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
  try {
    fs.unlinkSync(configPath);
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  getDb().exec("DELETE FROM fetch_gate");
});

describe("gateState first_call", () => {
  test("returns open with first_call when no row exists", () => {
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, true);
    assert.equal(s.reason, "first_call");
    assert.equal(s.last_fetched_at, null);
    assert.equal(s.next_eligible_at, null);
    assert.equal(s.last_status, null);
  });
});

describe("gateState after success", () => {
  test("interval not yet elapsed → closed", () => {
    writeGateSuccess({
      operation: "op_short",
      account_id: "acct1",
      status: 200,
      when: Date.now() - 5_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, false);
    assert.equal(s.reason, "interval_not_elapsed");
    assert.ok(s.next_eligible_at);
    assert.equal(s.last_status, 200);
  });

  test("interval elapsed → open with interval_elapsed reason", () => {
    writeGateSuccess({
      operation: "op_short",
      account_id: "acct1",
      status: 200,
      when: Date.now() - 60_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, true);
    assert.equal(s.reason, "interval_elapsed");
  });

  test("interval=never after success → closed forever (never_after_success)", () => {
    writeGateSuccess({ operation: "op_never", account_id: "acct1", status: 200 });
    const s = gateState("op_never", "acct1");
    assert.equal(s.open, false);
    assert.equal(s.reason, "never_after_success");
    assert.equal(s.next_eligible_at, null);
  });

  test("interval=always → always open", () => {
    writeGateSuccess({
      operation: "op_always",
      account_id: "acct1",
      status: 200,
      when: Date.now() - 1,
    });
    const s = gateState("op_always", "acct1");
    assert.equal(s.open, true);
  });
});

describe("gateState after error", () => {
  test("4xx uses error_retry_intervals", () => {
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: 404,
      error: "not_found",
      when: Date.now() - 1_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, false); // 10m retry, only 1s passed
    assert.equal(s.reason, "interval_not_elapsed");
    assert.equal(s.last_status, 404);
  });

  test("4xx with elapsed retry interval reopens", () => {
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: 404,
      error: "not_found",
      when: Date.now() - 11 * 60_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, true);
    assert.equal(s.reason, "interval_elapsed");
  });

  test("error code with 'never' retry → closed forever (never_after_error)", () => {
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: 401,
      error: "unauthorized",
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, false);
    assert.equal(s.reason, "never_after_error");
    assert.equal(s.last_status, 401);
  });

  test("network error (status null) uses 'network' retry interval", () => {
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: null,
      error: "ECONNRESET",
      when: Date.now() - 5_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, false); // 30s, 5s elapsed
  });

  test("network error after 30s elapsed reopens", () => {
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: null,
      error: "ECONNRESET",
      when: Date.now() - 60_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, true);
  });

  test("5xx uses 5xx fallback retry interval", () => {
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: 503,
      error: "down",
      when: Date.now() - 30_000,
    });
    const s = gateState("op_short", "acct1");
    assert.equal(s.open, false); // 1m, 30s elapsed
    writeGateError({
      operation: "op_short",
      account_id: "acct1",
      status: 503,
      error: "down",
      when: Date.now() - 90_000,
    });
    const s2 = gateState("op_short", "acct1");
    assert.equal(s2.open, true);
  });
});

describe("writeGate transitions", () => {
  test("success after error clears last_error and updates last_status", () => {
    writeGateError({ operation: "op_short", account_id: "acct1", status: 404, error: "x" });
    writeGateSuccess({ operation: "op_short", account_id: "acct1", status: 200 });
    const r = readGate("op_short", "acct1")!;
    assert.equal(r.last_status, 200);
    assert.equal(r.last_error, null);
  });

  test("error after success records error", () => {
    writeGateSuccess({ operation: "op_short", account_id: "acct1", status: 200 });
    writeGateError({ operation: "op_short", account_id: "acct1", status: 503, error: "down" });
    const r = readGate("op_short", "acct1")!;
    assert.equal(r.last_status, 503);
    assert.equal(r.last_error, "down");
  });

  test("rows are scoped per (operation, account_id)", () => {
    writeGateSuccess({ operation: "op_short", account_id: "A", status: 200 });
    writeGateSuccess({ operation: "op_short", account_id: "B", status: 200 });
    writeGateSuccess({ operation: "op_long", account_id: "A", status: 200 });
    assert.ok(readGate("op_short", "A"));
    assert.ok(readGate("op_short", "B"));
    assert.ok(readGate("op_long", "A"));
    assert.equal(readGate("op_short", "C"), undefined);
  });
});

describe("ISO helpers", () => {
  test("nextEligibleIso returns valid ISO after success", () => {
    writeGateSuccess({ operation: "op_short", account_id: "acct1", status: 200 });
    const iso = nextEligibleIso("op_short", "acct1");
    assert.ok(iso);
    assert.ok(!Number.isNaN(Date.parse(iso!)));
  });

  test("nextEligibleIso null for never_after_success", () => {
    writeGateSuccess({ operation: "op_never", account_id: "acct1", status: 200 });
    assert.equal(nextEligibleIso("op_never", "acct1"), null);
  });

  test("lastFetchedIso null for first_call", () => {
    assert.equal(lastFetchedIso("op_short", "fresh"), null);
  });

  test("lastFetchedIso returns ISO after a write", () => {
    writeGateSuccess({ operation: "op_short", account_id: "acct1", status: 200 });
    const iso = lastFetchedIso("op_short", "acct1");
    assert.ok(iso && !Number.isNaN(Date.parse(iso)));
  });
});
