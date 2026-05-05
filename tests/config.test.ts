import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseInterval,
  expandHome,
  loadThrottleConfig,
  intervalForOperation,
  intervalForError,
} from "../src/config.ts";

describe("parseInterval", () => {
  test("seconds", () => {
    assert.equal(parseInterval("30s"), 30_000);
    assert.equal(parseInterval("1s"), 1_000);
  });
  test("minutes", () => {
    assert.equal(parseInterval("5m"), 300_000);
    assert.equal(parseInterval("60m"), 3_600_000);
  });
  test("hours", () => {
    assert.equal(parseInterval("1h"), 3_600_000);
    assert.equal(parseInterval("24h"), 86_400_000);
  });
  test("days", () => {
    assert.equal(parseInterval("1d"), 86_400_000);
    assert.equal(parseInterval("7d"), 7 * 86_400_000);
  });
  test("never literal", () => {
    assert.equal(parseInterval("never"), "never");
  });
  test("always literal", () => {
    assert.equal(parseInterval("always"), "always");
  });
  test("case insensitive", () => {
    assert.equal(parseInterval("NEVER"), "never");
    assert.equal(parseInterval("Always"), "always");
    assert.equal(parseInterval("1H"), 3_600_000);
  });
  test("trims whitespace", () => {
    assert.equal(parseInterval("  10m  "), 600_000);
  });
  test("invalid throws", () => {
    assert.throws(() => parseInterval("foo"));
    assert.throws(() => parseInterval(""));
    assert.throws(() => parseInterval("10"));
    assert.throws(() => parseInterval("10x"));
    assert.throws(() => parseInterval("h10"));
  });
});

describe("expandHome", () => {
  test("expands ~/", () => {
    assert.equal(expandHome("~/foo/bar"), path.join(os.homedir(), "foo/bar"));
  });
  test("expands ~ alone", () => {
    assert.equal(expandHome("~"), os.homedir());
  });
  test("leaves absolute path alone", () => {
    assert.equal(expandHome("/abs/path"), "/abs/path");
  });
  test("leaves relative path alone", () => {
    assert.equal(expandHome("rel/path"), "rel/path");
  });
});

describe("loadThrottleConfig", () => {
  let tmpFile: string;

  test("loads valid config and exposes intervals", () => {
    tmpFile = path.join(os.tmpdir(), `throttle-cfg-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        version: 1,
        default_min_interval: "1h",
        operations: { foo: "30s", bar: "never", baz: "always" },
        error_retry_intervals: { "404": "5m", "5xx": "1m", "401": "never", network: "30s" },
      }),
    );
    const cfg = loadThrottleConfig(tmpFile);
    assert.equal(cfg.default_min_interval, "1h");

    assert.equal(intervalForOperation("foo"), 30_000);
    assert.equal(intervalForOperation("bar"), "never");
    assert.equal(intervalForOperation("baz"), "always");
    assert.equal(intervalForOperation("unknown"), 3_600_000);

    assert.equal(intervalForError(404), 300_000);
    assert.equal(intervalForError(401), "never");
    assert.equal(intervalForError(503), 60_000);
    assert.equal(intervalForError(500), 60_000);
    assert.equal(intervalForError("network"), 30_000);

    fs.unlinkSync(tmpFile);
  });

  test("throws on invalid interval string in operations", () => {
    const f = path.join(os.tmpdir(), `bad-cfg-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        default_min_interval: "1h",
        operations: { foo: "garbage" },
        error_retry_intervals: {},
      }),
    );
    assert.throws(() => loadThrottleConfig(f));
    fs.unlinkSync(f);
  });

  test("throws on missing default_min_interval", () => {
    const f = path.join(os.tmpdir(), `bad2-cfg-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(f, JSON.stringify({ version: 1, operations: {}, error_retry_intervals: {} }));
    assert.throws(() => loadThrottleConfig(f));
    fs.unlinkSync(f);
  });
});
