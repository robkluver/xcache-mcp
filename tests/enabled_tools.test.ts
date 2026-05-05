import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ALL_TOOL_NAMES, DEFAULT_ENABLED_TOOLS } from "../src/config.ts";
import { enabledToolDefinitions, TOOL_DEFINITIONS } from "../src/tools.ts";

describe("enabledToolDefinitions", () => {
  test("filters TOOL_DEFINITIONS to the enabled set", () => {
    const r = enabledToolDefinitions(new Set(["x_posts_since", "x_get_tweet"]));
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((t) => t.name).sort(), ["x_get_tweet", "x_posts_since"]);
  });

  test("empty set → empty array", () => {
    assert.deepEqual(enabledToolDefinitions(new Set()), []);
  });

  test("all-enabled → all 7", () => {
    const r = enabledToolDefinitions(new Set(ALL_TOOL_NAMES));
    assert.equal(r.length, 7);
  });

  test("default starred set returns the two ★ tools only", () => {
    const r = enabledToolDefinitions(new Set(DEFAULT_ENABLED_TOOLS));
    assert.deepEqual(r.map((t) => t.name).sort(), ["x_follows_changes_since", "x_posts_since"]);
  });

  test("ignores names not in the catalog", () => {
    const r = enabledToolDefinitions(new Set(["x_posts_since", "bogus"]));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.name, "x_posts_since");
  });

  test("preserves the original definition order", () => {
    const r = enabledToolDefinitions(new Set(ALL_TOOL_NAMES));
    const catalogOrder = TOOL_DEFINITIONS.map((t) => t.name);
    assert.deepEqual(
      r.map((t) => t.name),
      catalogOrder,
    );
  });
});

describe("ALL_TOOL_NAMES", () => {
  test("matches the keys present in TOOL_DEFINITIONS exactly", () => {
    const fromCatalog = TOOL_DEFINITIONS.map((t) => t.name).sort();
    const fromConst = [...ALL_TOOL_NAMES].sort();
    assert.deepEqual(fromConst, fromCatalog);
  });

  test("DEFAULT_ENABLED_TOOLS is a subset of ALL_TOOL_NAMES", () => {
    for (const name of DEFAULT_ENABLED_TOOLS) {
      assert.ok(ALL_TOOL_NAMES.includes(name), `${name} missing from ALL_TOOL_NAMES`);
    }
  });

  test("default contains exactly the two ★ monitoring tools", () => {
    assert.deepEqual([...DEFAULT_ENABLED_TOOLS].sort(), [
      "x_follows_changes_since",
      "x_posts_since",
    ]);
  });
});
