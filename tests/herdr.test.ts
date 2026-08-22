import assert from "node:assert/strict";
import test from "node:test";
import {
  HerdrClient,
  HerdrCommandError,
  type HerdrCommandRunner,
  parseHerdrError,
  parseHerdrResult,
} from "../src/herdr.ts";
import { OrchestrationError } from "../src/orchestrator.ts";

test("parseHerdrResult rejects malformed JSON", () => {
  assert.throws(
    () => parseHerdrResult("not json", "pane current"),
    HerdrCommandError,
  );
});

test("Herdr errors satisfy the orchestration error contract", () => {
  assert.ok(
    new HerdrCommandError("agent wait", "timed out", "", {
      code: "timeout",
    }) instanceof OrchestrationError,
  );
});

test("parseHerdrError reads structured CLI diagnostics", () => {
  assert.deepEqual(
    parseHerdrError(
      JSON.stringify({
        error: {
          code: "agent_pane_busy",
          message: "pane is not an available shell",
        },
      }),
    ),
    {
      code: "agent_pane_busy",
      message: "pane is not an available shell",
    },
  );
  assert.equal(parseHerdrError("plain stderr"), undefined);
});

test("HerdrClient requires a managed Herdr environment", async () => {
  const runner: HerdrCommandRunner = async () => ({ stdout: "", stderr: "" });
  const client = new HerdrClient(runner, {});

  await assert.rejects(() => client.currentPane(), /Herdr-managed pane/);
});

test("HerdrClient promptUntilWorking confirms prompt acceptance once", async () => {
  let args: string[] | undefined;
  const runner: HerdrCommandRunner = async (invocation) => {
    args = invocation.args;
    return jsonOutput({
      agent: { agent_status: "working", pane_id: "w1:p2" },
    });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(
    await client.promptUntilWorking("worker", "approved prompt", 12_345),
    { status: "working", paneId: "w1:p2" },
  );
  assert.deepEqual(args, [
    "agent",
    "prompt",
    "worker",
    "approved prompt",
    "--wait",
    "--until",
    "working",
    "--until",
    "blocked",
    "--timeout",
    "12345",
  ]);
});

test("HerdrClient promptAndWait parses lifecycle and Pi session data", async () => {
  let commandTimeout: number | undefined;
  const runner: HerdrCommandRunner = async (_invocation, timeoutMs) => {
    commandTimeout = timeoutMs;
    return {
      stdout: JSON.stringify({
        result: {
          agent: {
            agent_status: "done",
            pane_id: "w1:p2",
            agent_session: {
              agent: "pi",
              kind: "path",
              value: "/tmp/child.jsonl",
            },
          },
        },
      }),
      stderr: "",
    };
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(await client.promptAndWait("worker", "question", 12_345), {
    status: "done",
    paneId: "w1:p2",
    session: { agent: "pi", kind: "path", value: "/tmp/child.jsonl" },
  });
  assert.equal(commandTimeout, 17_345);
  await assert.rejects(
    () => client.promptAndWait("worker", "question", 0),
    RangeError,
  );
});

test("HerdrClient preserves a Claude session ID", async () => {
  const runner: HerdrCommandRunner = async () =>
    jsonOutput({
      agent: {
        agent_status: "idle",
        pane_id: "w1:p2",
        agent_session: {
          agent: "claude",
          kind: "id",
          value: "12345678-1234-1234-1234-123456789abc",
        },
      },
    });
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(await client.getAgent("worker"), {
    status: "idle",
    paneId: "w1:p2",
    session: {
      agent: "claude",
      kind: "id",
      value: "12345678-1234-1234-1234-123456789abc",
    },
  });
});

test("HerdrClient waitForAgent waits without resubmitting a prompt", async () => {
  let args: string[] | undefined;
  let commandTimeout: number | undefined;
  const runner: HerdrCommandRunner = async (invocation, timeoutMs) => {
    args = invocation.args;
    commandTimeout = timeoutMs;
    return jsonOutput({
      agent: {
        agent_status: "idle",
        pane_id: "w1:p2",
        agent_session: {
          agent: "pi",
          kind: "path",
          value: "/tmp/child.jsonl",
        },
      },
    });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(await client.waitForAgent("worker", 12_345), {
    status: "idle",
    paneId: "w1:p2",
    session: { agent: "pi", kind: "path", value: "/tmp/child.jsonl" },
  });
  assert.deepEqual(args, [
    "agent",
    "wait",
    "worker",
    "--until",
    "idle",
    "--until",
    "done",
    "--until",
    "blocked",
    "--timeout",
    "12345",
  ]);
  assert.equal(commandTimeout, 17_345);

  await client.waitForAgent("worker", 1_000, ["working", "blocked"]);
  assert.deepEqual(args, [
    "agent",
    "wait",
    "worker",
    "--until",
    "working",
    "--until",
    "blocked",
    "--timeout",
    "1000",
  ]);
  await assert.rejects(
    () => client.waitForAgent("worker", 1_000, []),
    RangeError,
  );
});

test("HerdrClient getAgent reads the current durable session reference", async () => {
  let args: string[] | undefined;
  const runner: HerdrCommandRunner = async (invocation) => {
    args = invocation.args;
    return jsonOutput({
      agent: {
        agent_status: "working",
        pane_id: "w1:p2",
        agent_session: {
          agent: "pi",
          kind: "path",
          value: "/tmp/child.jsonl",
        },
      },
    });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(await client.getAgent("worker"), {
    status: "working",
    paneId: "w1:p2",
    session: { agent: "pi", kind: "path", value: "/tmp/child.jsonl" },
  });
  assert.deepEqual(args, ["agent", "get", "worker"]);
});

test("HerdrClient reads global pane focus state", async () => {
  let args: string[] | undefined;
  const runner: HerdrCommandRunner = async (invocation) => {
    args = invocation.args;
    return jsonOutput({ pane: { focused: false } });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.equal(await client.paneIsFocused("w1:p1"), false);
  assert.deepEqual(args, ["pane", "get", "w1:p1"]);
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

  assert.equal(await client.currentPane(), "w1:p1");
  assert.deepEqual(
    await client.splitPane({
      paneId: "w1:p1",
      cwd: "/tmp/project with spaces",
      direction: "right",
    }),
    "w1:p2",
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

test("HerdrClient retries agent_pane_busy while the same shell initializes", async () => {
  const calls: string[][] = [];
  let startAttempts = 0;
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation.args);
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "process-info") {
      return jsonOutput({
        process_info: {
          shell_pid: 123,
          foreground_process_group_id: 123,
          foreground_processes: [{ pid: 123, name: "zsh" }],
        },
      });
    }
    startAttempts += 1;
    if (startAttempts === 1) {
      throw new HerdrCommandError(
        "agent start",
        "pane is not an available shell",
        "",
        { code: "agent_pane_busy" },
      );
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await client.startAgent("pi", "worker", "w1:p2", ["--tools", "read"]);

  assert.equal(startAttempts, 2);
  assert.deepEqual(calls, [
    ["pane", "get", "w1:p2"],
    [
      "agent",
      "start",
      "worker",
      "--kind",
      "pi",
      "--pane",
      "w1:p2",
      "--timeout",
      "30000",
      "--",
      "--tools",
      "read",
    ],
    ["pane", "get", "w1:p2"],
    ["pane", "process-info", "--pane", "w1:p2"],
    [
      "agent",
      "start",
      "worker",
      "--kind",
      "pi",
      "--pane",
      "w1:p2",
      "--timeout",
      "30000",
      "--",
      "--tools",
      "read",
    ],
  ]);
});

test("HerdrClient does not retry a busy pane after terminal replacement", async () => {
  let paneReads = 0;
  let startAttempts = 0;
  const runner: HerdrCommandRunner = async (invocation) => {
    if (invocation.args[1] === "get") {
      paneReads += 1;
      return jsonOutput({
        pane: { terminal_id: paneReads === 1 ? "term-2" : "term-3" },
      });
    }
    startAttempts += 1;
    throw new HerdrCommandError(
      "agent start",
      "pane is not an available shell",
      "",
      { code: "agent_pane_busy" },
    );
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await assert.rejects(
    () => client.startAgent("pi", "worker", "w1:p2", []),
    /not an available shell/,
  );
  assert.equal(startAttempts, 1);
});

function jsonOutput(result: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ result }),
    stderr: "",
  };
}
