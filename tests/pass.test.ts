import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeLaunchArgs,
  resolveClaudeTranscriptPath,
} from "../src/claude-target.ts";
import {
  launchClaudePass,
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

test("parsePassArguments parses a Claude goal and optional model", () => {
  assert.deepEqual(parsePassArguments("claude --model opus continue the MVP"), {
    target: "claude",
    model: "opus",
    goal: "continue the MVP",
  });
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

test("buildClaudeLaunchArgs validates and separates destination model arguments", () => {
  assert.deepEqual(buildClaudeLaunchArgs({ readOnly: false }), []);
  assert.deepEqual(
    buildClaudeLaunchArgs({ readOnly: false, model: "sonnet" }),
    ["--model", "sonnet"],
  );
  assert.deepEqual(buildClaudeLaunchArgs({ readOnly: true, model: "sonnet" }), [
    "--tools",
    "Read,Grep,Glob",
    "--disallowedTools",
    "mcp__*",
    "--permission-mode",
    "dontAsk",
    "--model",
    "sonnet",
  ]);
  assert.throws(
    () => buildClaudeLaunchArgs({ readOnly: false, model: "  " }),
    /must not be empty/,
  );
});

test("resolveClaudeTranscriptPath maps cwd and rejects unsafe session IDs", () => {
  assert.equal(
    resolveClaudeTranscriptPath(
      "/Users/example/project space",
      "12345678-1234-1234-1234-123456789abc",
      "/home/example",
    ),
    "/home/example/.claude/projects/-Users-example-project-space/12345678-1234-1234-1234-123456789abc.jsonl",
  );
  assert.throws(
    () =>
      resolveClaudeTranscriptPath(
        "/tmp/project",
        "../../unsafe",
        "/home/example",
      ),
    /must be a UUID/,
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
      ["pane", "get", "w1:p2"],
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
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        "30000",
      ],
      ["agent", "focus", "portr-pass-test"],
    ],
  );
});

test("launchClaudePass starts, prompts, then focuses the destination", async () => {
  const calls: HerdrInvocation[] = [];
  const runner = createPassRunner(calls);
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  const result = await launchClaudePass(client, {
    originPaneId: "w1:p1",
    cwd: "/tmp/project with spaces",
    agentName: "portr-pass-claude-test",
    prompt: "Approved Claude handoff\nwith another line",
    model: "sonnet",
  });

  assert.deepEqual(result, {
    agentName: "portr-pass-claude-test",
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
      ["pane", "get", "w1:p2"],
      [
        "agent",
        "start",
        "portr-pass-claude-test",
        "--kind",
        "claude",
        "--pane",
        "w1:p2",
        "--timeout",
        "30000",
        "--",
        "--model",
        "sonnet",
      ],
      [
        "agent",
        "prompt",
        "portr-pass-claude-test",
        "Approved Claude handoff\nwith another line",
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        "30000",
      ],
      ["agent", "focus", "portr-pass-claude-test"],
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
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
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

test("launchClaudePass preserves references and does not focus after prompt failure", async () => {
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "prompt") {
      throw new Error("prompt rejected");
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await assert.rejects(
    () =>
      launchClaudePass(client, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        agentName: "portr-pass-claude-test",
        prompt: "Approved handoff",
      }),
    (error: unknown) => {
      assert.ok(error instanceof PassLaunchError);
      assert.equal(error.stage, "prompt");
      assert.equal(error.paneId, "w1:p2");
      assert.equal(error.agentName, "portr-pass-claude-test");
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.args[1] === "focus"),
    false,
  );
});

test("launchClaudePass preserves a blocked destination without focusing", async () => {
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: { agent_status: "blocked", pane_id: "w1:p2" },
      });
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await assert.rejects(
    () =>
      launchClaudePass(client, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        agentName: "portr-pass-claude-test",
        prompt: "Approved handoff",
      }),
    (error: unknown) => {
      assert.ok(error instanceof PassLaunchError);
      assert.equal(error.stage, "prompt");
      assert.equal(error.paneId, "w1:p2");
      assert.match(error.message, /blocked/);
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
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: { agent_status: "working", pane_id: "w1:p2" },
      });
    }
    return jsonOutput({ ok: true });
  };
}

function jsonOutput(result: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ result }),
    stderr: "",
  };
}
