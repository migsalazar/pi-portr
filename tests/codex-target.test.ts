import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AskResultError } from "../src/ask-result.ts";
import {
  buildCodexLaunchArgs,
  extractCodexSessionAnswer,
  extractFinalCodexAssistantAnswer,
  resolveCodexSessionReference,
} from "../src/codex-target.ts";

const SESSION_ID = "01a06ddf-9cf0-7c62-a759-dab16950e51d";
const PROMPT = "Inspect package.json";
const PROMPT_SHA256 = createHash("sha256").update(PROMPT).digest("hex");

test("buildCodexLaunchArgs applies read-only policy and model explicitly", () => {
  assert.deepEqual(buildCodexLaunchArgs({ readOnly: false }), [
    "-c",
    "check_for_update_on_startup=false",
  ]);
  assert.deepEqual(buildCodexLaunchArgs({ readOnly: true, model: "gpt-5.4" }), [
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "-c",
    'approvals_reviewer="user"',
    "-c",
    "check_for_update_on_startup=false",
    "--model",
    "gpt-5.4",
  ]);
  assert.throws(
    () => buildCodexLaunchArgs({ readOnly: false, model: "  " }),
    /must not be empty/,
  );
});

test("Codex session references reject other harnesses", () => {
  const codex = {
    agent: "codex" as const,
    kind: "id" as const,
    value: SESSION_ID,
  };
  const claude = {
    agent: "claude" as const,
    kind: "id" as const,
    value: SESSION_ID,
  };

  assert.equal(resolveCodexSessionReference(codex), SESSION_ID);
  assert.equal(resolveCodexSessionReference(claude), undefined);
  assert.equal(
    resolveCodexSessionReference({
      agent: "codex",
      kind: "id",
      value: "not-a-uuid",
    }),
    undefined,
  );
});

test("Codex extraction selects one completed final answer for the exact prompt", async () => {
  const result = codexResult([
    codexTurn(PROMPT, {
      items: [
        userMessage(PROMPT),
        { type: "agentMessage", phase: "commentary", text: "Inspecting" },
        { type: "reasoning", content: ["hidden"] },
        {
          type: "agentMessage",
          phase: "final_answer",
          text: "Answer data:image/png;base64,AAABBB==",
        },
      ],
    }),
  ]);

  assert.equal(
    extractFinalCodexAssistantAnswer(result, SESSION_ID, PROMPT_SHA256),
    "Answer [base64 data omitted]",
  );
  assert.equal(
    await extractCodexSessionAnswer(
      SESSION_ID,
      PROMPT_SHA256,
      async () => result,
    ),
    "Answer [base64 data omitted]",
  );
});

test("Codex extraction rejects incomplete, failed, unmatched, and ambiguous turns", () => {
  for (const status of ["interrupted", "inProgress"] as const) {
    assert.throws(
      () =>
        extractFinalCodexAssistantAnswer(
          codexResult([codexTurn(PROMPT, { status })]),
          SESSION_ID,
          PROMPT_SHA256,
        ),
      new RegExp(`turn ${status}`),
    );
  }
  assert.throws(
    () =>
      extractFinalCodexAssistantAnswer(
        codexResult([
          codexTurn(PROMPT, {
            status: "failed",
            error: { message: "rate limited" },
          }),
        ]),
        SESSION_ID,
        PROMPT_SHA256,
      ),
    /turn failed: rate limited/,
  );
  assert.throws(
    () =>
      extractFinalCodexAssistantAnswer(
        codexResult([codexTurn("Different prompt")]),
        SESSION_ID,
        PROMPT_SHA256,
      ),
    /no turn for the submitted prompt/,
  );
  assert.throws(
    () =>
      extractFinalCodexAssistantAnswer(
        codexResult([codexTurn(PROMPT), codexTurn(PROMPT)]),
        SESSION_ID,
        PROMPT_SHA256,
      ),
    /multiple turns/,
  );
});

test("Codex extraction rejects missing, duplicate, or empty final answers", () => {
  for (const items of [
    [userMessage(PROMPT)],
    [
      userMessage(PROMPT),
      { type: "agentMessage", phase: "final_answer", text: "one" },
      { type: "agentMessage", phase: "final_answer", text: "two" },
    ],
    [
      userMessage(PROMPT),
      { type: "agentMessage", phase: "final_answer", text: "   " },
    ],
  ]) {
    assert.throws(
      () =>
        extractFinalCodexAssistantAnswer(
          codexResult([codexTurn(PROMPT, { items })]),
          SESSION_ID,
          PROMPT_SHA256,
        ),
      AskResultError,
    );
  }
});

function codexResult(turns: unknown[]): unknown {
  return { thread: { id: SESSION_ID, turns } };
}

function codexTurn(
  prompt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "turn-1",
    status: "completed",
    error: null,
    items: [
      userMessage(prompt),
      { type: "agentMessage", phase: "final_answer", text: "Answer" },
    ],
    ...overrides,
  };
}

function userMessage(prompt: string): Record<string, unknown> {
  return {
    type: "userMessage",
    content: [{ type: "text", text: prompt }],
  };
}
