import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseInterval,
  expandHome,
  loadAppFileConfig,
  resolveToolsFromFile,
  intervalForOperation,
  intervalForError,
  ALL_TOOL_NAMES,
  DEFAULT_ENABLED_TOOLS,
  getFileEnabledTools,
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

function writeTmpConfig(body: object): string {
  const f = path.join(os.tmpdir(), `app-cfg-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
}

describe("loadAppFileConfig", () => {
  test("loads valid full config and exposes intervals", () => {
    const f = writeTmpConfig({
      version: 1,
      tools: { enabled: ["x_posts_since"] },
      throttle: {
        default_min_interval: "1h",
        operations: { foo: "30s", bar: "never", baz: "always" },
        error_retry_intervals: { "404": "5m", "5xx": "1m", "401": "never", network: "30s" },
      },
    });
    const cfg = loadAppFileConfig(f);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.throttle.default_min_interval, "1h");

    assert.equal(intervalForOperation("foo"), 30_000);
    assert.equal(intervalForOperation("bar"), "never");
    assert.equal(intervalForOperation("baz"), "always");
    assert.equal(intervalForOperation("unknown"), 3_600_000);

    assert.equal(intervalForError(404), 300_000);
    assert.equal(intervalForError(401), "never");
    assert.equal(intervalForError(503), 60_000);
    assert.equal(intervalForError(500), 60_000);
    assert.equal(intervalForError("network"), 30_000);

    fs.unlinkSync(f);
  });

  test("loads config with optional sections (server, storage, x_api, logging)", () => {
    const f = writeTmpConfig({
      version: 1,
      server: { host: "0.0.0.0", port: 9999, http: { enabled: false }, stdio: { enabled: false } },
      storage: { root: "/tmp/xcache-test-root" },
      x_api: { base: "http://localhost:1234" },
      logging: { level: "debug", events: false, bodies: false },
      throttle: {
        default_min_interval: "1h",
        operations: {},
        error_retry_intervals: {},
      },
    });
    const cfg = loadAppFileConfig(f);
    assert.equal(cfg.server?.host, "0.0.0.0");
    assert.equal(cfg.server?.port, 9999);
    assert.equal(cfg.server?.http?.enabled, false);
    assert.equal(cfg.server?.stdio?.enabled, false);
    assert.equal(cfg.storage?.root, "/tmp/xcache-test-root");
    assert.equal(cfg.x_api?.base, "http://localhost:1234");
    assert.equal(cfg.logging?.level, "debug");
    assert.equal(cfg.logging?.events, false);
    assert.equal(cfg.logging?.bodies, false);
    fs.unlinkSync(f);
  });

  test("throws on missing version", () => {
    const f = writeTmpConfig({
      throttle: { default_min_interval: "1h", operations: {}, error_retry_intervals: {} },
    });
    assert.throws(() => loadAppFileConfig(f));
    fs.unlinkSync(f);
  });

  test("throws on missing throttle section", () => {
    const f = writeTmpConfig({ version: 1 });
    assert.throws(() => loadAppFileConfig(f));
    fs.unlinkSync(f);
  });

  test("throws on missing throttle.default_min_interval", () => {
    const f = writeTmpConfig({
      version: 1,
      throttle: { operations: {}, error_retry_intervals: {} },
    });
    assert.throws(() => loadAppFileConfig(f));
    fs.unlinkSync(f);
  });

  test("throws on invalid interval string in operations", () => {
    const f = writeTmpConfig({
      version: 1,
      throttle: {
        default_min_interval: "1h",
        operations: { foo: "garbage" },
        error_retry_intervals: {},
      },
    });
    assert.throws(() => loadAppFileConfig(f));
    fs.unlinkSync(f);
  });
});

describe("resolveToolsFromFile", () => {
  test("undefined section → default starred set", () => {
    assert.deepEqual(
      [...resolveToolsFromFile(undefined)].sort(),
      [...DEFAULT_ENABLED_TOOLS].sort(),
    );
  });
  test("absent enabled key → default starred set", () => {
    assert.deepEqual([...resolveToolsFromFile({})].sort(), [...DEFAULT_ENABLED_TOOLS].sort());
  });
  test('"*" → all 7 tools', () => {
    assert.deepEqual(
      [...resolveToolsFromFile({ enabled: "*" })].sort(),
      [...ALL_TOOL_NAMES].sort(),
    );
  });
  test("explicit list", () => {
    const r = resolveToolsFromFile({ enabled: ["x_posts_since", "x_get_tweet"] });
    assert.deepEqual([...r].sort(), ["x_get_tweet", "x_posts_since"]);
  });
  test("empty list → empty set (explicitly disable all)", () => {
    assert.equal(resolveToolsFromFile({ enabled: [] }).size, 0);
  });
  test("non-array, non-* throws", () => {
    assert.throws(() => resolveToolsFromFile({ enabled: "x_get_tweet" as unknown as string[] }));
  });
  test("non-string entries throw", () => {
    assert.throws(() => resolveToolsFromFile({ enabled: [42 as unknown as string] }));
  });
  test("unknown names are dropped (with warning to stderr)", () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((c: string | Uint8Array) => {
      captured += c.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      const r = resolveToolsFromFile({ enabled: ["x_posts_since", "bogus"] });
      assert.deepEqual([...r], ["x_posts_since"]);
      assert.ok(captured.includes('"bogus"'));
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe("loadAppFileConfig + tools section integration", () => {
  test("file with tools.enabled list updates getFileEnabledTools()", () => {
    const f = writeTmpConfig({
      version: 1,
      tools: { enabled: ["x_get_tweet", "x_raw_get"] },
      throttle: { default_min_interval: "1h", operations: {}, error_retry_intervals: {} },
    });
    loadAppFileConfig(f);
    assert.deepEqual([...getFileEnabledTools()].sort(), ["x_get_tweet", "x_raw_get"]);
    fs.unlinkSync(f);
  });

  test("file with tools section absent uses default starred set", () => {
    const f = writeTmpConfig({
      version: 1,
      throttle: { default_min_interval: "1h", operations: {}, error_retry_intervals: {} },
    });
    loadAppFileConfig(f);
    assert.deepEqual([...getFileEnabledTools()].sort(), [...DEFAULT_ENABLED_TOOLS].sort());
    fs.unlinkSync(f);
  });

  test('file with tools.enabled = "*" enables all 7', () => {
    const f = writeTmpConfig({
      version: 1,
      tools: { enabled: "*" },
      throttle: { default_min_interval: "1h", operations: {}, error_retry_intervals: {} },
    });
    loadAppFileConfig(f);
    assert.deepEqual([...getFileEnabledTools()].sort(), [...ALL_TOOL_NAMES].sort());
    fs.unlinkSync(f);
  });
});

describe("x_api.earliest_data_iso", () => {
  test("absent → preserved as undefined on the file model", () => {
    const f = writeTmpConfig({
      version: 1,
      throttle: { default_min_interval: "1h", operations: {}, error_retry_intervals: {} },
    });
    const cfg = loadAppFileConfig(f);
    assert.equal(cfg.x_api?.earliest_data_iso, undefined);
    fs.unlinkSync(f);
  });

  test("valid ISO 8601 string is accepted", () => {
    const f = writeTmpConfig({
      version: 1,
      x_api: { earliest_data_iso: "2025-01-01T00:00:00Z" },
      throttle: { default_min_interval: "1h", operations: {}, error_retry_intervals: {} },
    });
    const cfg = loadAppFileConfig(f);
    assert.equal(cfg.x_api?.earliest_data_iso, "2025-01-01T00:00:00Z");
    fs.unlinkSync(f);
  });
});
