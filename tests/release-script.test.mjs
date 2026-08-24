import assert from "node:assert/strict";
import test from "node:test";
import { resolveRelease } from "../scripts/release.mjs";

test("resolveRelease defaults to the next patch version", () => {
  assert.deepEqual(resolveRelease([], "0.1.9"), {
    npmArgument: "patch",
    tag: "v0.1.10",
    version: "0.1.10",
  });
});

test("resolveRelease accepts a greater exact stable tag", () => {
  assert.deepEqual(resolveRelease(["v0.2.0"], "0.1.9"), {
    npmArgument: "0.2.0",
    tag: "v0.2.0",
    version: "0.2.0",
  });
});

test("resolveRelease rejects invalid or non-increasing versions", () => {
  assert.throws(() => resolveRelease(["0.2.0"], "0.1.1"), /Usage/);
  assert.throws(() => resolveRelease(["v0.1.1"], "0.1.1"), /must be greater/);
  assert.throws(() => resolveRelease(["v0.1.0"], "0.1.1"), /must be greater/);
  assert.throws(() => resolveRelease(["v0.01.0"], "0.1.1"), /Usage/);
  assert.throws(() => resolveRelease(["v0.2.0-beta.1"], "0.1.1"), /Usage/);
  assert.throws(() => resolveRelease(["v0.2.0", "extra"], "0.1.1"), /Usage/);
  assert.throws(
    () => resolveRelease([], "0.1.1-beta.1"),
    /not a stable X.Y.Z version/,
  );
});
