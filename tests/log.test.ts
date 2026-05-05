import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb, getDb } from "../src/cache.ts";
import { LogWriter, todayUtc, type EventLogEntry } from "../src/log.ts";

let dbPath: string;

before(() => {
  dbPath = path.join(os.tmpdir(), `xcache-log-test-${Date.now()}-${Math.random()}.db`);
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

function makeEvent(req_id: string): EventLogEntry {
  return {
    ts: new Date().toISOString(),
    request_id: req_id,
    client_kind: "rest",
    method: "GET",
    url: "https://api.x.com/2/users/1",
    requested_fields: [],
    is_paginated: false,
    status: 200,
    source: "live",
    cache_outcome: "miss",
    duration_ms: 100,
    response_bytes: 200,
  };
}

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xcache-logwriter-"));
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bodies"), { recursive: true });
  return dir;
}

describe("LogWriter event logging", () => {
  test("enqueue + flush writes JSONL line", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    w.enqueueEvent(makeEvent("req-1"));
    await w.flush();
    const file = path.join(dir, "events", `${todayUtc()}.jsonl`);
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.request_id, "req-1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("multiple events written in order", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    for (let i = 0; i < 5; i++) w.enqueueEvent(makeEvent(`m-${i}`));
    await w.flush();
    const file = path.join(dir, "events", `${todayUtc()}.jsonl`);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 5);
    for (let i = 0; i < 5; i++) {
      const o = JSON.parse(lines[i]!);
      assert.equal(o.request_id, `m-${i}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("file is mode 0600", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    w.enqueueEvent(makeEvent("mode-test"));
    await w.flush();
    const file = path.join(dir, "events", `${todayUtc()}.jsonl`);
    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o777, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("LogWriter body logging respects logBodies flag", () => {
  test("logBodies=true writes body file", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    w.enqueueBody({ request_id: "rb1", body: '{"x":1}' });
    await w.flush();
    const file = path.join(dir, "bodies", `${todayUtc()}.jsonl`);
    assert.ok(fs.existsSync(file));
    const obj = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.equal(obj.request_id, "rb1");
    assert.equal(obj.body, '{"x":1}');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("logBodies=false skips body file entirely", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, false);
    w.enqueueBody({ request_id: "skipped", body: "should-not-appear" });
    await w.flush();
    const file = path.join(dir, "bodies", `${todayUtc()}.jsonl`);
    assert.ok(!fs.existsSync(file), "body file should not be created");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("LogWriter bounded queue overflow", () => {
  test("drops oldest at capacity, increments dropped_log_entries counter", async () => {
    const dir = freshDir();
    // Reset counter.
    getDb().prepare("DELETE FROM proxy_meta WHERE key = ?").run("dropped_log_entries");
    const w = new LogWriter(dir, true);
    // Capacity is 10_000. Enqueue 10_001 → exactly 1 drop expected.
    for (let i = 0; i < 10_001; i++) {
      w.enqueueEvent(makeEvent(`bulk-${i}`));
    }
    const counterRow = getDb()
      .prepare("SELECT value FROM proxy_meta WHERE key = ?")
      .get("dropped_log_entries") as { value: string } | undefined;
    assert.equal(counterRow?.value, "1");

    await w.flush();
    const file = path.join(dir, "events", `${todayUtc()}.jsonl`);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 10_000, "10_000 events should reach disk after 1 drop");
    // First survivor should be bulk-1, last should be bulk-10000.
    assert.equal(JSON.parse(lines[0]!).request_id, "bulk-1");
    assert.equal(JSON.parse(lines[lines.length - 1]!).request_id, "bulk-10000");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("LogWriter drainWithDeadline", () => {
  test("empties queue", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    w.enqueueEvent(makeEvent("drain-1"));
    w.enqueueEvent(makeEvent("drain-2"));
    w.enqueueBody({ request_id: "drain-1", body: "xxx" });
    await w.drainWithDeadline(2000);
    const ev = path.join(dir, "events", `${todayUtc()}.jsonl`);
    const bo = path.join(dir, "bodies", `${todayUtc()}.jsonl`);
    const evText = fs.readFileSync(ev, "utf8");
    const boText = fs.readFileSync(bo, "utf8");
    assert.ok(evText.includes("drain-1"));
    assert.ok(evText.includes("drain-2"));
    assert.ok(boText.includes("drain-1"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("safe to call on empty queue", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    await w.drainWithDeadline(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("LogWriter stop()", () => {
  test("further enqueues are no-ops after stop", async () => {
    const dir = freshDir();
    const w = new LogWriter(dir, true);
    w.stop();
    w.enqueueEvent(makeEvent("after-stop"));
    await w.flush();
    const file = path.join(dir, "events", `${todayUtc()}.jsonl`);
    assert.ok(!fs.existsSync(file), "no event should be written after stop()");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("todayUtc", () => {
  test("returns YYYY-MM-DD", () => {
    assert.match(todayUtc(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
