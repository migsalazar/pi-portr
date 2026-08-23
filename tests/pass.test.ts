import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildClaudeLaunchArgs,
  resolveClaudeTranscriptPath,
} from "../src/claude-target.ts";
import {
  launchPass,
  parsePassArguments,
  PassLaunchError,
  PassUsageError,
  registerPassCommand,
} from "../src/commands/pass.ts";
import {
  HerdrClient,
  type HerdrCommandRunner,
  type HerdrInvocation,
} from "../src/herdr.ts";
import type { Orchestrator } from "../src/orchestrator.ts";
import { buildPiLaunchArgs } from "../src/pi-target.ts";
import { PASS_RECEIPT_ENTRY, restorePassReceipts } from "../src/state.ts";

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

for (const targetCase of [
  {
    target: "pi" as const,
    agentName: "portr-pass-test",
    prompt: "Approved handoff\nwith another line",
    model: "anthropic/claude-sonnet",
  },
  {
    target: "claude" as const,
    agentName: "portr-pass-claude-test",
    prompt: "Approved Claude handoff\nwith another line",
    model: "sonnet",
  },
]) {
  test(`launchPass starts and focuses ${targetCase.target}`, async () => {
    const calls: HerdrInvocation[] = [];
    const runner = createPassRunner(calls);
    const client = new HerdrClient(runner, { HERDR_ENV: "1" });

    const result = await launchPass(targetCase.target, client, {
      originPaneId: "w1:p1",
      cwd: "/tmp/project with spaces",
      agentName: targetCase.agentName,
      prompt: targetCase.prompt,
      model: targetCase.model,
    });

    assert.deepEqual(result, {
      agentName: targetCase.agentName,
      paneId: "w1:p2",
      focusStatus: "focused",
    });
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["pane", "layout", "--pane", "w1:p1"],
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
          targetCase.agentName,
          "--kind",
          targetCase.target,
          "--pane",
          "w1:p2",
          "--timeout",
          "30000",
          "--",
          "--model",
          targetCase.model,
        ],
        [
          "agent",
          "prompt",
          targetCase.agentName,
          targetCase.prompt,
          "--wait",
          "--until",
          "working",
          "--until",
          "blocked",
          "--timeout",
          "30000",
        ],
        ["pane", "get", "w1:p1"],
        ["agent", "focus", targetCase.agentName],
      ],
    );
  });
}

test("launchPass preserves user focus after the origin loses focus", async () => {
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "layout") {
      return paneLayoutOutput();
    }
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({
        pane:
          invocation.args[2] === "w1:p1"
            ? { focused: false }
            : { terminal_id: "term-2" },
      });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: { agent_status: "working", pane_id: "w1:p2" },
      });
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(
    await launchPass("pi", client, {
      originPaneId: "w1:p1",
      cwd: "/tmp/project",
      agentName: "portr-pass-test",
      prompt: "Approved handoff",
    }),
    {
      agentName: "portr-pass-test",
      paneId: "w1:p2",
      focusStatus: "skipped",
    },
  );
  assert.equal(
    calls.some((call) => call.args[1] === "focus"),
    false,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === "pane" &&
        call.args[1] === "get" &&
        call.args[2] === "w1:p1",
    ),
    true,
  );
});

test("launchPass preserves user focus when origin focus cannot be verified", async () => {
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "layout") {
      return paneLayoutOutput();
    }
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      if (invocation.args[2] === "w1:p1") {
        throw new Error("focus state unavailable");
      }
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: { agent_status: "working", pane_id: "w1:p2" },
      });
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  assert.deepEqual(
    await launchPass("pi", client, {
      originPaneId: "w1:p1",
      cwd: "/tmp/project",
      agentName: "portr-pass-test",
      prompt: "Approved handoff",
    }),
    {
      agentName: "portr-pass-test",
      paneId: "w1:p2",
      focusStatus: "skipped",
    },
  );
  assert.equal(
    calls.some((call) => call.args[1] === "focus"),
    false,
  );
});

for (const targetCase of [
  { target: "pi" as const, agentName: "portr-pass-test" },
  { target: "claude" as const, agentName: "portr-pass-claude-test" },
]) {
  test(`launchPass preserves ${targetCase.target} references after prompt failure`, async () => {
    const calls: HerdrInvocation[] = [];
    const runner: HerdrCommandRunner = async (invocation) => {
      calls.push(invocation);
      if (invocation.args[1] === "layout") {
        return paneLayoutOutput();
      }
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
        launchPass(targetCase.target, client, {
          originPaneId: "w1:p1",
          cwd: "/tmp/project",
          agentName: targetCase.agentName,
          prompt: "Approved handoff",
        }),
      (error: unknown) => {
        assert.ok(error instanceof PassLaunchError);
        assert.equal(error.stage, "prompt");
        assert.equal(error.paneId, "w1:p2");
        assert.equal(error.agentName, targetCase.agentName);
        return true;
      },
    );
    assert.equal(
      calls.some((call) => call.args[1] === "focus"),
      false,
    );
  });
}

test("launchPass preserves a blocked destination without focusing", async () => {
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "layout") {
      return paneLayoutOutput();
    }
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
      launchPass("claude", client, {
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

test("portr-pass persists the exact approved prompt and useful transitions", async () => {
  const run = await runPassCommand();
  const receipts = run.entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === PASS_RECEIPT_ENTRY
      ? [entry.data as { deliveryStatus: string; focusStatus: string }]
      : [],
  );
  const latest = [...restorePassReceipts(run.entries).values()][0];

  assert.deepEqual(
    receipts.map((receipt) => [receipt.deliveryStatus, receipt.focusStatus]),
    [
      ["approved", "not_attempted"],
      ["approved", "not_attempted"],
      ["delivered", "not_attempted"],
      ["delivered", "focused"],
    ],
  );
  assert.equal(latest?.approvedPrompt, "# Approved handoff\n\nExact text");
  assert.equal(latest?.goal, "continue the MVP");
  assert.equal(latest?.paneId, "w1:p2");
  assert.equal(latest?.childSession, "/tmp/child.jsonl");
  assert.equal(latest?.launchStage, "focus");
});

test("portr-pass preserves the approved receipt when settings are unavailable", async () => {
  const run = await runPassCommand({ settingsFailure: true });
  const receipt = [...restorePassReceipts(run.entries).values()][0];

  assert.equal(receipt?.approvedPrompt, "# Approved handoff\n\nExact text");
  assert.equal(receipt?.launchStage, "split");
  assert.equal(receipt?.deliveryStatus, "failed");
  assert.match(receipt?.failure?.message ?? "", /settings unavailable/);
});

test("portr-pass records an actionable split failure at the pane limit", async () => {
  const run = await runPassCommand({ paneCount: 4 });
  const receipt = [...restorePassReceipts(run.entries).values()][0];

  assert.equal(receipt?.launchStage, "split");
  assert.equal(receipt?.deliveryStatus, "failed");
  assert.equal(receipt?.paneId, undefined);
  assert.match(receipt?.failure?.message ?? "", /pane limit reached \(4\/4\)/);
  assert.match(run.notifications.at(-1) ?? "", /\/portr-settings/);
});

test("portr-pass cancellation, invalid payload, and in-memory origin create no receipt", async () => {
  const cancelled = await runPassCommand({ approvedPrompt: undefined });
  const base64 = await runPassCommand({
    approvedPrompt: "data:image/png;base64,AAABBB==",
  });
  const inMemory = await runPassCommand({ originSession: undefined });

  assert.equal(cancelled.entries.length, 0);
  assert.equal(base64.entries.length, 0);
  assert.match(base64.notifications.at(-1) ?? "", /base64/);
  assert.equal(inMemory.entries.length, 0);
  assert.equal(inMemory.customCalls, 0);
  assert.match(inMemory.notifications.at(-1) ?? "", /persisted origin/);
});

for (const failureStage of ["split", "start", "prompt", "focus"] as const) {
  test(`portr-pass preserves a receipt after ${failureStage} failure`, async () => {
    const run = await runPassCommand({ failureStage });
    const receipt = [...restorePassReceipts(run.entries).values()][0];

    assert.equal(receipt?.launchStage, failureStage);
    assert.match(receipt?.failure?.message ?? "", /failed|rejected/);
    if (failureStage === "split") {
      assert.equal(receipt?.paneId, undefined);
    } else {
      assert.equal(receipt?.paneId, "w1:p2");
    }
    if (failureStage === "focus") {
      assert.equal(receipt?.deliveryStatus, "delivered");
      assert.equal(receipt?.focusStatus, "failed");
    } else {
      assert.equal(receipt?.deliveryStatus, "failed");
      assert.equal(receipt?.focusStatus, "not_attempted");
    }
  });
}

async function runPassCommand(
  options: {
    approvedPrompt?: string | undefined;
    originSession?: string | undefined;
    failureStage?: "split" | "start" | "prompt" | "focus";
    paneCount?: number;
    settingsFailure?: boolean;
  } = {},
): Promise<{
  entries: SessionEntry[];
  notifications: string[];
  customCalls: number;
}> {
  const entries: SessionEntry[] = [];
  const contextEntries: SessionEntry[] = [
    {
      type: "message",
      id: "context-user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: "Continue this implementation",
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      },
    },
  ];
  const notifications: string[] = [];
  let customCalls = 0;
  let entryIndex = 0;
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const pi = {
    registerCommand: (
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      handler = command.handler;
    },
    appendEntry: (customType: string, data?: unknown) => {
      entryIndex += 1;
      entries.push({
        type: "custom",
        id: `entry-${entryIndex}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
  } as unknown as ExtensionAPI;
  const orchestrator = {
    currentPane: async () => "w1:p1",
    paneLayout: async () => ({
      paneCount: options.paneCount ?? 1,
      origin: { width: 181, height: 58 },
    }),
    splitPane: async () => {
      if (options.failureStage === "split") {
        throw new Error("split failed");
      }
      return "w1:p2";
    },
    startAgent: async () => {
      if (options.failureStage === "start") {
        throw new Error("start failed");
      }
    },
    promptUntilWorking: async () => {
      if (options.failureStage === "prompt") {
        throw new Error("prompt failed");
      }
      return {
        status: "working" as const,
        paneId: "w1:p2",
        session: {
          agent: "pi" as const,
          kind: "path" as const,
          value: "/tmp/child.jsonl",
        },
      };
    },
    paneIsFocused: async () => true,
    focus: async () => {
      if (options.failureStage === "focus") {
        throw new Error("focus failed");
      }
    },
  } as unknown as Orchestrator;
  registerPassCommand(
    pi,
    () => orchestrator,
    async () => {
      if (options.settingsFailure) {
        throw new Error("settings failed");
      }
      return { maxPanes: 4 };
    },
  );
  const hasApprovedPrompt = Object.hasOwn(options, "approvedPrompt");
  const approvedPrompt = hasApprovedPrompt
    ? options.approvedPrompt
    : "# Approved handoff\n\nExact text";
  const ctx = {
    mode: "tui",
    cwd: "/tmp/project",
    model: { provider: "test", id: "model" },
    sessionManager: {
      getSessionFile: () =>
        Object.hasOwn(options, "originSession")
          ? options.originSession
          : "/tmp/origin.jsonl",
      getEntries: () => contextEntries,
      getLeafId: () => "context-user",
    },
    modelRegistry: {},
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async () => {
        customCalls += 1;
        return { status: "ok", text: "Generated handoff" };
      },
      editor: async () => approvedPrompt,
    },
  } as unknown as ExtensionCommandContext;

  await handler?.("pi continue the MVP", ctx);
  return { entries, notifications, customCalls };
}

function createPassRunner(calls: HerdrInvocation[]): HerdrCommandRunner {
  return async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "layout") {
      return paneLayoutOutput();
    }
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({
        pane:
          invocation.args[2] === "w1:p1"
            ? { focused: true }
            : { terminal_id: "term-2" },
      });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: { agent_status: "working", pane_id: "w1:p2" },
      });
    }
    return jsonOutput({ ok: true });
  };
}

function paneLayoutOutput(): { stdout: string; stderr: string } {
  return jsonOutput({
    layout: {
      zoomed: false,
      panes: [{ pane_id: "w1:p1", rect: { width: 181, height: 58 } }],
    },
  });
}

function jsonOutput(result: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ result }),
    stderr: "",
  };
}
