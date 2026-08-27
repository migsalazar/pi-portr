import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type AskDeliveryPort,
  deliverTerminalAskOperation,
  hasAskResultMessage,
} from "../src/async-ask.ts";
import {
  ASYNC_ASK_OPERATION_ENTRY,
  ASYNC_ASK_RESULT_MESSAGE,
  type AsyncAskOperation,
  PASS_RECEIPT_ENTRY,
  type PassReceipt,
  restoreAsyncAskOperations,
  restorePassReceipts,
} from "../src/state.ts";

test("restoreAsyncAskOperations keeps the latest valid branch snapshot", () => {
  const working = operation({ status: "working", updatedAt: 10 });
  const completed = operation({
    status: "completed",
    updatedAt: 20,
    childSession: "/tmp/child.jsonl",
    result: storedResult(),
  });
  const entries: SessionEntry[] = [
    customEntry("one", working),
    customEntry("invalid", { ...working, deadlineAt: "later" }),
    customEntry("two", completed),
  ];

  const restored = restoreAsyncAskOperations(entries);

  assert.equal(restored.size, 1);
  assert.deepEqual(restored.get("operation-1"), completed);
});

test("restoreAsyncAskOperations preserves provenance and historical absence", () => {
  const noContext = operation({
    noContext: true,
    requestedModel: "anthropic/claude-sonnet",
    contextCharacters: 0,
    readOnlyPolicy: "harness-tools",
    promptSha256: "a".repeat(64),
  });
  const historical = operation({ operationId: "operation-historical" });
  const restored = restoreAsyncAskOperations([
    customEntry("no-context", noContext),
    customEntry("historical", historical),
  ]);

  assert.equal(restored.get(noContext.operationId)?.noContext, true);
  assert.equal(
    restored.get(noContext.operationId)?.requestedModel,
    "anthropic/claude-sonnet",
  );
  assert.equal(restored.get(noContext.operationId)?.contextCharacters, 0);
  assert.equal(
    restored.get(noContext.operationId)?.readOnlyPolicy,
    "harness-tools",
  );
  assert.equal(
    restored.get(noContext.operationId)?.promptSha256,
    "a".repeat(64),
  );
  assert.equal(restored.get(historical.operationId)?.noContext, undefined);
  assert.equal(
    restored.get(historical.operationId)?.contextCharacters,
    undefined,
  );
});

test("restoreAsyncAskOperations rejects malformed provenance", () => {
  const current = operation();
  const entries = [
    customEntry("negative-context", { ...current, contextCharacters: -1 }),
    customEntry("invalid-policy", { ...current, readOnlyPolicy: "sandbox" }),
    customEntry("invalid-hash", { ...current, promptSha256: "not-a-hash" }),
  ];

  assert.equal(restoreAsyncAskOperations(entries).size, 0);
});

test("restoreAsyncAskOperations accepts Claude receipts without cwd and preserves historical cwd", () => {
  const claude = operation({ target: "claude" });
  const historical = operation({
    operationId: "operation-historical",
    target: "claude",
    cwd: "/tmp/project",
  });

  const restored = restoreAsyncAskOperations([
    customEntry("current", claude),
    customEntry("historical", historical),
  ]);

  assert.deepEqual(restored.get(claude.operationId), claude);
  assert.deepEqual(restored.get(historical.operationId), historical);
});

test("restoreAsyncAskOperations accepts recoverable blocked and historical failed snapshots", () => {
  const blocked = operation({
    status: "blocked",
    failure: { reason: "blocked", message: "needs approval" },
  });
  const historical = operation({
    operationId: "operation-historical",
    status: "failed",
    failure: { reason: "blocked", message: "needs approval" },
    result: storedResult(),
  });
  const restored = restoreAsyncAskOperations([
    customEntry("blocked", blocked),
    customEntry("historical", historical),
  ]);

  assert.deepEqual(restored.get(blocked.operationId), blocked);
  assert.deepEqual(restored.get(historical.operationId), historical);
});

test("restorePassReceipts keeps the latest valid receipt", () => {
  const approved = passReceipt();
  const delivered = passReceipt({
    deliveryStatus: "delivered",
    paneId: "w1:p2",
    launchStage: "prompt",
    updatedAt: 2,
  });
  const entries: SessionEntry[] = [
    passEntry("approved", approved),
    passEntry("invalid", { ...approved, approvedPrompt: "" }),
    passEntry("delivered", delivered),
  ];

  assert.deepEqual(
    restorePassReceipts(entries).get(approved.operationId),
    delivered,
  );
});

test("restorePassReceipts preserves cwd and accepts historical receipts without it", () => {
  const current = passReceipt({ cwd: "/tmp/feature-worktree" });
  const historical = passReceipt({
    operationId: "pass-historical",
  });
  const malformed = passReceipt({
    operationId: "pass-malformed",
    cwd: "",
  });
  const restored = restorePassReceipts([
    passEntry("current", current),
    passEntry("historical", historical),
    passEntry("malformed", malformed),
  ]);

  assert.equal(restored.get(current.operationId)?.cwd, current.cwd);
  assert.equal(restored.get(historical.operationId)?.cwd, undefined);
  assert.equal(restored.has(malformed.operationId), false);
});

test("hasAskResultMessage matches durable delivery by operation ID", () => {
  const entries: SessionEntry[] = [
    {
      type: "custom_message",
      id: "result",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: ASYNC_ASK_RESULT_MESSAGE,
      content: "answer",
      display: true,
      details: { operationId: "operation-1" },
    },
  ];

  assert.equal(hasAskResultMessage(entries, "operation-1"), true);
  assert.equal(hasAskResultMessage(entries, "operation-2"), false);
});

test("deliverTerminalAskOperation sends a follow-up and awaits durable acknowledgment", () => {
  const completed = operation({
    status: "completed",
    childSession: "/tmp/child.jsonl",
    result: storedResult(),
  });
  const sent: unknown[] = [];
  const persisted: AsyncAskOperation[] = [];
  const port: AskDeliveryPort = {
    send: (result, options) => sent.push({ result, options }),
    persist: (snapshot) => persisted.push(snapshot),
  };

  const outcome = deliverTerminalAskOperation(completed, [], port, 123);

  assert.equal(outcome, "sent");
  assert.deepEqual(sent, [
    {
      result: storedResult(),
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  assert.equal(persisted.length, 0);
});

test("delivery reconciliation does not duplicate an existing result message", () => {
  const completed = operation({
    status: "completed",
    childSession: "/tmp/child.jsonl",
    result: storedResult(),
  });
  const entries: SessionEntry[] = [
    {
      type: "custom_message",
      id: "result",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: ASYNC_ASK_RESULT_MESSAGE,
      content: "answer",
      display: true,
      details: { operationId: completed.operationId },
    },
  ];
  let sendCount = 0;
  const persisted: AsyncAskOperation[] = [];

  const outcome = deliverTerminalAskOperation(completed, entries, {
    send: () => {
      sendCount += 1;
    },
    persist: (snapshot) => persisted.push(snapshot),
  });

  assert.equal(outcome, "already_present");
  assert.equal(sendCount, 0);
  assert.equal(persisted[0]?.status, "delivered");
});

function operation(
  overrides: Partial<AsyncAskOperation> = {},
): AsyncAskOperation {
  return {
    version: 1,
    kind: "ask",
    operationId: "operation-1",
    target: "pi",
    status: "working",
    originSession: "/tmp/origin.jsonl",
    question: "What changed?",
    agentName: "portr-ask-test",
    paneId: "w1:p2",
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 1_000,
    ...overrides,
  };
}

function passReceipt(overrides: Partial<PassReceipt> = {}): PassReceipt {
  return {
    version: 1,
    kind: "pass",
    operationId: "pass-1",
    originSession: "/tmp/origin.jsonl",
    target: "pi",
    goal: "Continue the work",
    approvedPrompt: "# Handoff\n\nContinue the work",
    deliveryStatus: "approved",
    focusStatus: "not_attempted",
    launchStage: "approved",
    agentName: "portr-pass-test",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function storedResult(): {
  content: string;
  details: Record<string, unknown>;
} {
  return {
    content: "answer",
    details: { operationId: "operation-1", status: "completed" },
  };
}

function customEntry(id: string, data: unknown): SessionEntry {
  return customEntryOfType(id, ASYNC_ASK_OPERATION_ENTRY, data);
}

function passEntry(id: string, data: unknown): SessionEntry {
  return customEntryOfType(id, PASS_RECEIPT_ENTRY, data);
}

function customEntryOfType(
  id: string,
  customType: string,
  data: unknown,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType,
    data,
  };
}
