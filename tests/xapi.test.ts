import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactHeaders, buildUrl, newRequestId, REDACTED } from "../src/xapi.ts";

describe("redactHeaders", () => {
  test("redacts lowercase Authorization", () => {
    const r = redactHeaders({ authorization: "Bearer XYZ_SECRET" });
    assert.equal(r.authorization, REDACTED);
    assert(!JSON.stringify(r).includes("XYZ_SECRET"));
  });
  test("redacts mixed-case Authorization", () => {
    const r = redactHeaders({ Authorization: "Bearer XYZ_SECRET" });
    assert.equal(r.Authorization, REDACTED);
  });
  test("redacts UPPERCASE AUTHORIZATION", () => {
    const r = redactHeaders({ AUTHORIZATION: "Bearer XYZ_SECRET" });
    assert.equal(r.AUTHORIZATION, REDACTED);
  });
  test("preserves other headers as-is", () => {
    const r = redactHeaders({
      "content-type": "application/json",
      "x-rate-limit-remaining": "144",
      "x-custom": "ok",
    });
    assert.equal(r["content-type"], "application/json");
    assert.equal(r["x-rate-limit-remaining"], "144");
    assert.equal(r["x-custom"], "ok");
  });
  test("does not touch other auth-like headers", () => {
    const r = redactHeaders({
      "authorization-other": "still-here",
      "x-authorization": "still-here",
    });
    assert.equal(r["authorization-other"], "still-here");
    assert.equal(r["x-authorization"], "still-here");
  });
  test("empty headers returns empty", () => {
    assert.deepEqual(redactHeaders({}), {});
  });
});

describe("buildUrl", () => {
  test("appends and sorts params", () => {
    assert.equal(
      buildUrl("https://api.x.com", "/2/u", { c: "3", a: "1" }),
      "https://api.x.com/2/u?a=1&c=3",
    );
  });
  test("normalizes leading slash", () => {
    assert.equal(
      buildUrl("https://api.x.com", "2/u", { a: "1" }),
      "https://api.x.com/2/u?a=1",
    );
  });
  test("skips undefined params", () => {
    assert.equal(
      buildUrl("https://api.x.com", "/2/u", { a: "1", b: undefined }),
      "https://api.x.com/2/u?a=1",
    );
  });
  test("skips null params", () => {
    assert.equal(
      buildUrl("https://api.x.com", "/2/u", { a: "1", b: null as unknown as undefined }),
      "https://api.x.com/2/u?a=1",
    );
  });
  test("no params at all", () => {
    assert.equal(buildUrl("https://api.x.com", "/2/u"), "https://api.x.com/2/u");
  });
  test("handles non-string param types", () => {
    assert.equal(
      buildUrl("https://api.x.com", "/2/u", { n: 42, b: true }),
      "https://api.x.com/2/u?b=true&n=42",
    );
  });
  test("URL-encodes special chars in values", () => {
    assert.equal(
      buildUrl("https://api.x.com", "/2/u", { q: "a&b=c" }),
      "https://api.x.com/2/u?q=a%26b%3Dc",
    );
  });
});

describe("newRequestId", () => {
  test("starts with 01J", () => {
    const id = newRequestId();
    assert(id.startsWith("01J"));
    assert(id.length > 10);
  });
  test("uppercase hex/base32 only (no lowercase)", () => {
    for (let i = 0; i < 20; i++) {
      const id = newRequestId();
      assert(/^[A-Z0-9]+$/.test(id), `id had invalid chars: ${id}`);
    }
  });
  test("each call returns a unique value", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newRequestId());
    assert.equal(ids.size, 200);
  });
});
