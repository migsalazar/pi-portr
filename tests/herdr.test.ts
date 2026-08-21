import assert from "node:assert/strict";
import test from "node:test";
import {
  createHerdrInvocation,
  HerdrClient,
  HerdrCommandError,
  type HerdrCommandRunner,
  parseHerdrError,
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
    sessionPath: "/tmp/child.jsonl",
  });
  assert.equal(commandTimeout, 17_345);
  await assert.rejects(
    () => client.promptAndWait("worker", "question", 0),
    RangeError,
  );
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

  await client.startPi("worker", "w1:p2", ["--tools", "read"]);

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
    () => client.startPi("worker", "w1:p2", []),
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
