import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrInvocation } from "../src/herdr.ts";

test("createHerdrInvocation preserves arguments without shell parsing", () => {
  const args = ["agent", "prompt", "worker name", "line one\nline two"];
  const invocation = createHerdrInvocation(args);

  assert.deepEqual(invocation, {
    executable: "herdr",
    args,
  });
  assert.notStrictEqual(invocation.args, args);
});

test("createHerdrInvocation accepts an injected executable", () => {
  assert.deepEqual(
    createHerdrInvocation(["agent", "status"], "/tmp/fake-herdr"),
    {
      executable: "/tmp/fake-herdr",
      args: ["agent", "status"],
    },
  );
});
