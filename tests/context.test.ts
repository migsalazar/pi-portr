import assert from "node:assert/strict";
import test from "node:test";
import { boundText } from "../src/context.ts";

test("boundText preserves content that fits the limit", () => {
  assert.deepEqual(boundText("context", 10), {
    text: "context",
    truncated: false,
    originalLength: 7,
  });
});

test("boundText reports deterministic truncation", () => {
  assert.deepEqual(boundText("context", 4), {
    text: "cont",
    truncated: true,
    originalLength: 7,
  });
});

test("boundText rejects invalid limits", () => {
  assert.throws(() => boundText("context", 0), RangeError);
});
