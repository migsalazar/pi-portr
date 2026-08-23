import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cleanupClaudeAskReceipt,
  extractClaudeReceiptAnswer,
  prepareClaudeAskReceipt,
  type ClaudeAskReceiptLaunch,
} from "../src/claude-target.ts";

const SESSION_ID = "12345678-1234-1234-1234-123456789abc";
const PROMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Hook correlation is the completion contract; unrelated pane activity is ignored.
test("Claude hooks bind the exact prompt and keep the latest matching Stop", () => {
  const operationId = randomUUID();
  const prompt = "Inspect the API";
  const receipt = prepareClaudeAskReceipt(operationId, prompt);

  try {
    runHook(receipt, promptEvent(prompt));
    runHook(
      receipt,
      stopEvent("First answer", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );
    assert.throws(
      () => extractClaudeReceiptAnswer(operationId, SESSION_ID),
      /no terminal result/,
    );

    runHook(receipt, stopEvent("First answer"));
    assert.equal(
      extractClaudeReceiptAnswer(operationId, SESSION_ID),
      "First answer",
    );

    runHook(receipt, stopEvent("Latest data:image/png;base64,AAABBB== answer"));
    assert.equal(
      extractClaudeReceiptAnswer(operationId, SESSION_ID),
      "Latest [base64 data omitted] answer",
    );
  } finally {
    cleanupClaudeAskReceipt(operationId);
  }
});

test("Claude hooks ignore a different prompt before binding", () => {
  const operationId = randomUUID();
  const prompt = "Expected prompt";
  const receipt = prepareClaudeAskReceipt(operationId, prompt);

  try {
    runHook(receipt, promptEvent("Different prompt"));
    runHook(receipt, stopEvent("Wrong answer"));
    assert.throws(
      () => extractClaudeReceiptAnswer(operationId, SESSION_ID),
      /did not bind/,
    );

    runHook(receipt, promptEvent(prompt));
    runHook(receipt, stopEvent("Expected answer"));
    assert.equal(
      extractClaudeReceiptAnswer(operationId, SESSION_ID),
      "Expected answer",
    );
  } finally {
    cleanupClaudeAskReceipt(operationId);
  }
});

test("StopFailure is preserved as failure rather than assistant output", () => {
  const operationId = randomUUID();
  const prompt = "Expected prompt";
  const receipt = prepareClaudeAskReceipt(operationId, prompt);

  try {
    runHook(receipt, promptEvent(prompt));
    runHook(receipt, {
      ...commonEvent("StopFailure"),
      error: "rate_limit",
      error_details: "Try later",
      last_assistant_message: "API Error: Rate limit reached",
    });
    assert.throws(
      () => extractClaudeReceiptAnswer(operationId, SESSION_ID),
      /Claude turn failed \(rate_limit\): Try later/,
    );
  } finally {
    cleanupClaudeAskReceipt(operationId);
  }
});

test("missing prompt_id fails explicitly and cleaned receipts make hooks no-ops", () => {
  const operationId = randomUUID();
  const prompt = "Expected prompt";
  const receipt = prepareClaudeAskReceipt(operationId, prompt);

  runHook(receipt, {
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION_ID,
    prompt,
  });
  assert.throws(
    () => extractClaudeReceiptAnswer(operationId, SESSION_ID),
    /did not provide session_id and prompt_id/,
  );

  cleanupClaudeAskReceipt(operationId);
  runHook(receipt, stopEvent("Ignored after cleanup"));
});

test("Claude receipt settings use direct command arguments for each hook", () => {
  const operationId = randomUUID();
  const receipt = prepareClaudeAskReceipt(operationId, "Prompt");

  try {
    const settings = readSettings(receipt);
    for (const event of ["UserPromptSubmit", "Stop", "StopFailure"] as const) {
      const handler = settings.hooks[event][0]?.hooks[0];
      assert.equal(handler?.type, "command");
      assert.equal(handler?.command, process.execPath);
      assert.equal(handler?.args.length, 2);
      assert.equal(Object.hasOwn(handler ?? {}, "shell"), false);
      assert.equal(handler?.timeout, 5);
    }
  } finally {
    cleanupClaudeAskReceipt(operationId);
  }
});

function runHook(receipt: ClaudeAskReceiptLaunch, event: unknown): void {
  const handler = readSettings(receipt).hooks.UserPromptSubmit[0]?.hooks[0];
  assert.ok(handler);
  const result = spawnSync(handler.command, handler.args, {
    encoding: "utf8",
    input: JSON.stringify(event),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

function promptEvent(prompt: string): Record<string, unknown> {
  return { ...commonEvent("UserPromptSubmit"), prompt };
}

function stopEvent(
  answer: string,
  promptId = PROMPT_ID,
): Record<string, unknown> {
  return {
    ...commonEvent("Stop", promptId),
    stop_hook_active: false,
    last_assistant_message: answer,
  };
}

function commonEvent(
  hookEventName: string,
  promptId = PROMPT_ID,
): Record<string, unknown> {
  return {
    hook_event_name: hookEventName,
    session_id: SESSION_ID,
    prompt_id: promptId,
    cwd: "/tmp/project",
    permission_mode: "dontAsk",
  };
}

interface HookHandler {
  type: string;
  command: string;
  args: string[];
  timeout: number;
}

interface HookSettings {
  hooks: Record<
    "UserPromptSubmit" | "Stop" | "StopFailure",
    Array<{ hooks: HookHandler[] }>
  >;
}

function readSettings(receipt: ClaudeAskReceiptLaunch): HookSettings {
  return JSON.parse(receipt.settings) as HookSettings;
}
