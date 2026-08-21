import assert from "node:assert/strict";
import test from "node:test";
import {
  launchPiPass,
  parsePassArguments,
  PassLaunchError,
  PassUsageError,
} from "../src/commands/pass.ts";
import {
  HerdrClient,
  type HerdrCommandRunner,
  type HerdrInvocation,
} from "../src/herdr.ts";
import { buildPiLaunchArgs } from "../src/pi-target.ts";

test("parsePassArguments parses a Pi goal and optional model", () => {
  assert.deepEqual(
    parsePassArguments("pi --model anthropic/claude-sonnet continue the MVP"),
    {
      target: "pi",
      model: "anthropic/claude-sonnet",
      goal: "continue the MVP",
    },
  );
});

test("parsePassArguments preserves goal flags after a separator", () => {
  assert.deepEqual(parsePassArguments("pi -- implement --strict mode"), {
    target: "pi",
    goal: "implement --strict mode",
  });
});

test("parsePassArguments rejects invalid input", () => {
  assert.throws(() => parsePassArguments("codex review this"), PassUsageError);
  assert.throws(() => parsePassArguments("pi"), /goal is required/);
  assert.throws(
    () => parsePassArguments("pi --unknown goal"),
    /Unknown option/,
  );
  assert.throws(
    () => parsePassArguments("pi --model first --model second goal"),
    /only be provided once/,
  );
});

test("buildPiLaunchArgs separates read-only and destination model arguments", () => {
  assert.deepEqual(buildPiLaunchArgs({ readOnly: false }), []);
  assert.deepEqual(
    buildPiLaunchArgs({ readOnly: true, model: "anthropic/claude-sonnet" }),
    ["--tools", "read,grep,find,ls", "--model", "anthropic/claude-sonnet"],
  );
});

test("launchPiPass starts, prompts, then focuses the destination", async () => {
  const calls: HerdrInvocation[] = [];
  const runner = createPassRunner(calls);
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  const result = await launchPiPass(client, {
    originPaneId: "w1:p1",
    cwd: "/tmp/project with spaces",
    agentName: "portr-pass-test",
    prompt: "Approved handoff\nwith another line",
    model: "anthropic/claude-sonnet",
  });

  assert.deepEqual(result, {
    agentName: "portr-pass-test",
    paneId: "w1:p2",
  });
  assert.deepEqual(
    calls.map((call) => call.args),
    [
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
      [
        "agent",
        "start",
        "portr-pass-test",
        "--kind",
        "pi",
        "--pane",
        "w1:p2",
        "--timeout",
        "30000",
        "--",
        "--model",
        "anthropic/claude-sonnet",
      ],
      [
        "agent",
        "prompt",
        "portr-pass-test",
        "Approved handoff\nwith another line",
      ],
      ["agent", "focus", "portr-pass-test"],
    ],
  );
});

test("launchPiPass preserves references and does not focus after prompt failure", async () => {
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "prompt") {
      throw new Error("prompt rejected");
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await assert.rejects(
    () =>
      launchPiPass(client, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        agentName: "portr-pass-test",
        prompt: "Approved handoff",
      }),
    (error: unknown) => {
      assert.ok(error instanceof PassLaunchError);
      assert.equal(error.stage, "prompt");
      assert.equal(error.paneId, "w1:p2");
      assert.equal(error.agentName, "portr-pass-test");
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.args[1] === "focus"),
    false,
  );
});

function createPassRunner(calls: HerdrInvocation[]): HerdrCommandRunner {
  return async (invocation) => {
    calls.push(invocation);
    return invocation.args[1] === "split"
      ? jsonOutput({ pane: { pane_id: "w1:p2" } })
      : jsonOutput({ ok: true });
  };
}

function jsonOutput(result: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ result }),
    stderr: "",
  };
}
