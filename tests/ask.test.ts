import assert from "node:assert/strict";
import test from "node:test";
import {
  AskLaunchError,
  AskResultError,
  AskUsageError,
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

function jsonOutput(result: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({ result }),
    stderr: "",
  };
}
