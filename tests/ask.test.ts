import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  AskLaunchError,
  AskResultError,
  AskUsageError,
  AsyncAskCoordinator,
  buildAskPrompt,
  buildAskResultMessage,
  extractFinalAssistantAnswer,
  launchPiAsk,
  MAX_RETURN_ANSWER_CHARACTERS,
  parseAskArguments,
} from "../src/commands/ask.ts";
import {
  HerdrClient,
  type HerdrCommandRunner,
  type HerdrInvocation,
} from "../src/herdr.ts";
import {
  ASYNC_ASK_OPERATION_ENTRY,
  type AsyncAskOperation,
  restoreAsyncAskOperations,
} from "../src/state.ts";

test("parseAskArguments parses blocking Pi options", () => {
  assert.deepEqual(
    parseAskArguments(
      "pi --preview --model anthropic/claude-sonnet --wait inspect the API",
    ),
    {
      target: "pi",
      question: "inspect the API",
      wait: true,
      preview: true,
      model: "anthropic/claude-sonnet",
    },
  );
});

test("parseAskArguments preserves question flags after a separator", () => {
  assert.deepEqual(parseAskArguments("pi --wait -- explain --strict mode"), {
    target: "pi",
    question: "explain --strict mode",
    wait: true,
    preview: false,
  });
});

test("parseAskArguments rejects invalid or duplicate options", () => {
  assert.throws(
    () => parseAskArguments("codex --wait question"),
    AskUsageError,
  );
  assert.throws(() => parseAskArguments("pi --wait"), /question is required/);
  assert.throws(
    () => parseAskArguments("pi --preview --preview question"),
    /only be provided once/,
  );
  assert.throws(
    () => parseAskArguments("pi --unknown question"),
    /Unknown option/,
  );
});

test("buildAskPrompt separates and sanitizes context and question", () => {
  const prompt = buildAskPrompt(
    "User: We use SessionManager.open().",
    "How should data:image/png;base64,AAABBB== be extracted?",
  );

  assert.match(prompt, /# Read-only consultation/);
  assert.match(prompt, /## Quoted origin context/);
  assert.match(prompt, /User: We use SessionManager\.open\(\)\./);
  assert.match(prompt, /## Question/);
  assert.match(prompt, /How should \[base64 data omitted\] be extracted\?/);
  assert.doesNotMatch(prompt, /AAABBB/);
  assert.match(prompt, /Do not modify files/);
});

test("launchPiAsk starts read-only Pi and waits without focusing", async () => {
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
        agent: {
          agent_status: "idle",
          pane_id: "w1:p2",
          agent_session: {
            agent: "pi",
            kind: "path",
            value: "/tmp/child session.jsonl",
          },
        },
      });
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  const result = await launchPiAsk(client, {
    originPaneId: "w1:p1",
    cwd: "/tmp/project with spaces",
    agentName: "portr-ask-test",
    prompt: "Question\nwith another line",
    timeoutMs: 12_345,
    model: "anthropic/claude-sonnet",
  });

  assert.deepEqual(result, {
    agentName: "portr-ask-test",
    paneId: "w1:p2",
    sessionPath: "/tmp/child session.jsonl",
    status: "idle",
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
        "portr-ask-test",
        "--kind",
        "pi",
        "--pane",
        "w1:p2",
        "--timeout",
        "30000",
        "--",
        "--tools",
        "read,grep,find,ls",
        "--model",
        "anthropic/claude-sonnet",
      ],
      [
        "agent",
        "prompt",
        "portr-ask-test",
        "Question\nwith another line",
        "--wait",
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        "12345",
      ],
    ],
  );
  assert.equal(
    calls.some((call) => call.args[1] === "focus"),
    false,
  );
});

test("launchPiAsk preserves references when the destination is blocked", async () => {
  const runner: HerdrCommandRunner = async (invocation) => {
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: {
          agent_status: "blocked",
          pane_id: "w1:p2",
          agent_session: {
            agent: "pi",
            kind: "path",
            value: "/tmp/blocked.jsonl",
          },
        },
      });
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await assert.rejects(
    () =>
      launchPiAsk(client, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        agentName: "portr-ask-test",
        prompt: "Question",
      }),
    (error: unknown) => {
      assert.ok(error instanceof AskLaunchError);
      assert.equal(error.stage, "prompt_wait");
      assert.equal(error.status, "blocked");
      assert.equal(error.paneId, "w1:p2");
      assert.equal(error.sessionPath, "/tmp/blocked.jsonl");
      assert.match(error.message, /requires intervention/);
      return true;
    },
  );
});

test("launchPiAsk rejects ambiguous lifecycle states", async () => {
  const runner: HerdrCommandRunner = async (invocation) => {
    if (invocation.args[1] === "split") {
      return jsonOutput({ pane: { pane_id: "w1:p2" } });
    }
    if (invocation.args[1] === "get") {
      return jsonOutput({ pane: { terminal_id: "term-2" } });
    }
    if (invocation.args[1] === "prompt") {
      return jsonOutput({
        agent: { agent_status: "unknown", pane_id: "w1:p2" },
      });
    }
    return jsonOutput({ ok: true });
  };
  const client = new HerdrClient(runner, { HERDR_ENV: "1" });

  await assert.rejects(
    () =>
      launchPiAsk(client, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        agentName: "portr-ask-test",
        prompt: "Question",
      }),
    /ambiguous status unknown/,
  );
});

test("extractFinalAssistantAnswer returns only completed text", () => {
  const answer = extractFinalAssistantAnswer([
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "Inspecting" }],
    },
    { role: "toolResult", content: [{ type: "text", text: "secret" }] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "Answer data:image/png;base64,AAABBB==" },
      ],
    },
  ]);

  assert.equal(answer, "Answer [base64 data omitted]");
});

test("extractFinalAssistantAnswer rejects an incomplete final response", () => {
  assert.throws(
    () =>
      extractFinalAssistantAnswer([
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Earlier complete answer" }],
        },
        {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "Truncated answer" }],
        },
      ]),
    AskResultError,
  );
});

test("buildAskResultMessage labels bounded excerpts and preserves references", () => {
  const result = buildAskResultMessage({
    operationId: "operation-1",
    question: "What changed?",
    answer: "x".repeat(MAX_RETURN_ANSWER_CHARACTERS + 10),
    agentName: "portr-ask-test",
    paneId: "w1:p2",
    childSession: "/tmp/child.jsonl",
    originSession: "/tmp/origin.jsonl",
  });

  assert.match(result.content, /Bounded excerpt/);
  assert.match(result.content, /complete answer remains in the destination/);
  assert.equal(result.details.truncated, true);
  assert.equal(
    result.details.originalAnswerLength,
    MAX_RETURN_ANSWER_CHARACTERS + 10,
  );
  assert.equal(result.details.paneId, "w1:p2");
  assert.equal(result.details.childSession, "/tmp/child.jsonl");
});

test("AsyncAskCoordinator completes a fresh prompt and delivers a follow-up", async () => {
  const entries: SessionEntry[] = [];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    return agentOutput("idle");
  };
  const operation = workingOperation();
  const api = runtimeApi(entries, sent);
  const ctx = runtimeContext(entries);
  const coordinator = new AsyncAskCoordinator(api, {
    createHerdr: () => new HerdrClient(runner, { HERDR_ENV: "1" }),
    extractAnswer: () => "Recovered answer",
  });
  coordinator.reconcile(ctx);

  coordinator.monitorFresh(operation, "Question prompt", ctx);
  await waitFor(() => sent.length === 1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args[1], "prompt");
  assert.equal(calls[0]?.args[3], "Question prompt");
  assert.deepEqual(sent[0]?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.equal(
    restoreAsyncAskOperations(entries).get(operation.operationId)?.status,
    "completed",
  );

  coordinator.reconcile(ctx);
  assert.equal(sent.length, 1);
  coordinator.acknowledgePersistedResults(ctx);
  assert.equal(
    restoreAsyncAskOperations(entries).get(operation.operationId)?.status,
    "delivered",
  );
});

test("AsyncAskCoordinator recovers without resubmitting or duplicating", async () => {
  const operation = workingOperation();
  const entries: SessionEntry[] = [operationEntry("working", operation)];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const calls: HerdrInvocation[] = [];
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    return agentOutput("idle");
  };
  const api = runtimeApi(entries, sent);
  const ctx = runtimeContext(entries);
  const dependencies = {
    createHerdr: () => new HerdrClient(runner, { HERDR_ENV: "1" }),
    extractAnswer: () => "Recovered answer",
  };

  new AsyncAskCoordinator(api, dependencies).reconcile(ctx);
  await waitFor(() => sent.length === 1);

  assert.equal(
    calls.some((call) => call.args[1] === "prompt"),
    false,
  );
  assert.equal(calls[0]?.args[1], "get");

  new AsyncAskCoordinator(api, dependencies).reconcile(ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
});

test("AsyncAskCoordinator recovers completed output after its deadline", async () => {
  const operation = {
    ...workingOperation(),
    deadlineAt: Date.now() - 1,
  };
  const entries: SessionEntry[] = [operationEntry("working", operation)];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const runner: HerdrCommandRunner = async () => agentOutput("idle");
  const coordinator = new AsyncAskCoordinator(runtimeApi(entries, sent), {
    createHerdr: () => new HerdrClient(runner, { HERDR_ENV: "1" }),
    extractAnswer: () => "Already completed answer",
  });
  const ctx = runtimeContext(entries);

  coordinator.reconcile(ctx);
  await waitFor(() => sent.length === 1);
  coordinator.acknowledgePersistedResults(ctx);

  assert.equal(
    restoreAsyncAskOperations(entries).get(operation.operationId)?.outcome,
    "completed",
  );
});

test("AsyncAskCoordinator waits through a recovered pre-prompt idle state", async () => {
  const operation = workingOperation();
  const entries: SessionEntry[] = [operationEntry("working", operation)];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const calls: HerdrInvocation[] = [];
  let getCount = 0;
  let extractionCount = 0;
  const runner: HerdrCommandRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[1] === "get") {
      getCount += 1;
      return agentOutput(getCount === 1 ? "idle" : "working");
    }
    const waitsForWorking = invocation.args.includes("working");
    return agentOutput(waitsForWorking ? "working" : "idle");
  };
  const coordinator = new AsyncAskCoordinator(runtimeApi(entries, sent), {
    createHerdr: () => new HerdrClient(runner, { HERDR_ENV: "1" }),
    extractAnswer: () => {
      extractionCount += 1;
      if (extractionCount === 1) {
        throw new AskResultError("answer not persisted yet");
      }
      return "Recovered answer";
    },
  });

  coordinator.reconcile(runtimeContext(entries));
  await waitFor(() => sent.length === 1);

  assert.deepEqual(
    calls.map((call) => call.args[1]),
    ["get", "wait", "get", "wait"],
  );
  assert.equal(
    calls.some((call) => call.args[1] === "prompt"),
    false,
  );
});

function workingOperation(): AsyncAskOperation {
  const now = Date.now();
  return {
    version: 1,
    kind: "ask",
    operationId: "operation-async",
    target: "pi",
    status: "working",
    originSession: "/tmp/origin.jsonl",
    question: "What changed?",
    agentName: "portr-ask-test",
    paneId: "w1:p2",
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + 60_000,
  };
}

function runtimeApi(
  entries: SessionEntry[],
  sent: Array<{ message: unknown; options: unknown }>,
): ExtensionAPI {
  let entryIndex = entries.length;
  return {
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
    sendMessage: (message: unknown, options?: unknown) => {
      sent.push({ message, options });
      const result = message as {
        customType: string;
        content: string;
        display: boolean;
        details?: unknown;
      };
      entryIndex += 1;
      entries.push({
        type: "custom_message",
        id: `entry-${entryIndex}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: result.customType,
        content: result.content,
        display: result.display,
        details: result.details,
      });
    },
  } as unknown as ExtensionAPI;
}

function runtimeContext(entries: SessionEntry[]): ExtensionContext {
  return {
    sessionManager: {
      getSessionFile: () => "/tmp/origin.jsonl",
      getBranch: () => entries,
    },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
}

function operationEntry(
  id: string,
  operation: AsyncAskOperation,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: ASYNC_ASK_OPERATION_ENTRY,
    data: operation,
  };
}

function agentOutput(status: "idle" | "working"): {
  stdout: string;
  stderr: string;
} {
  return jsonOutput({
    agent: {
      agent_status: status,
      pane_id: "w1:p2",
      agent_session: {
        agent: "pi",
        kind: "path",
        value: "/tmp/child.jsonl",
      },
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for async ask test condition");
}

function jsonOutput(result: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ result }),
    stderr: "",
  };
}
