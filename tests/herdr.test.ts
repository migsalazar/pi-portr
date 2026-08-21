import assert from "node:assert/strict";
import test from "node:test";
import {
  createHerdrInvocation,
  HerdrClient,
  HerdrCommandError,
  type HerdrCommandRunner,
  parseHerdrResult,
} from "../src/herdr.ts";

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

test("parseHerdrResult rejects malformed JSON", () => {
  assert.throws(
    () => parseHerdrResult("not json", "pane current"),
    HerdrCommandError,
  );
});

test("HerdrClient requires a managed Herdr environment", async () => {
  const runner: HerdrCommandRunner = async () => ({ stdout: "", stderr: "" });
  const client = new HerdrClient(runner, {});

  await assert.rejects(() => client.currentPane(), /Herdr-managed pane/);
});

test("HerdrClient parses current and split pane IDs", async () => {
  const calls: string[][] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation.args);
    const paneId = invocation.args[1] === "current" ? "w1:p1" : "w1:p2";
    return {
      stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }),
      stderr: "",
    };
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(await client.currentPane(), { paneId: "w1:p1" });
  assert.deepEqual(
    await client.splitPane({
      paneId: "w1:p1",
      cwd: "/tmp/project with spaces",
      direction: "right",
    }),
    { paneId: "w1:p2" },
  );
  assert.deepEqual(calls, [
    ["pane", "current", "--current"],
    [
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/project with spaces",
      "--no-focus",
    ],
  ]);
});
