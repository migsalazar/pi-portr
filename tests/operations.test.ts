import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildOperationFooter,
  formatAskOperation,
  formatPassReceipt,
  registerOperationCommands,
  resolveAskOperation,
  resolveOperation,
} from "../src/commands/operations.ts";
import type { CreateOrchestrator } from "../src/orchestrator.ts";
import {
  ASYNC_ASK_OPERATION_ENTRY,
  type AsyncAskOperation,
  PASS_RECEIPT_ENTRY,
  type PassReceipt,
} from "../src/state.ts";

test("resolveAskOperation distinguishes active, other-origin, and missing IDs", () => {
  const active = operation();
  const entries: SessionEntry[] = [
    customEntry("active", active),
    customEntry(
      "other",
      operation({
        operationId: "operation-other",
        originSession: "/tmp/other.jsonl",
      }),
    ),
  ];

  assert.equal(
    resolveAskOperation(entries, active.originSession, active.operationId)
      .status,
    "found",
  );
  assert.equal(
    resolveAskOperation(entries, active.originSession, "operation-other")
      .status,
    "other_origin",
  );
  assert.equal(
    resolveAskOperation(entries, active.originSession, "operation-missing")
      .status,
    "missing",
  );
});

test("buildOperationFooter derives active and blocked counts from durable state", () => {
  const working = operation();
  const blocked = operation({
    operationId: "operation-blocked",
    status: "blocked",
    failure: { reason: "blocked", message: "needs intervention" },
  });
  const other = operation({
    operationId: "operation-other",
    originSession: "/tmp/other.jsonl",
  });
  const entries = [
    customEntry("working", working),
    customEntry("blocked", blocked),
    customEntry("other", other),
  ];

  assert.equal(
    buildOperationFooter(entries, working.originSession),
    "portr: 1 active, 1 blocked",
  );
  assert.equal(
    buildOperationFooter(entries, working.originSession, {
      ...working,
      status: "blocked",
      failure: { reason: "blocked", message: "needs intervention" },
    }),
    "portr: 2 blocked",
  );
  assert.equal(buildOperationFooter(entries, undefined), undefined);
});

test("buildOperationFooter uses a known terminal transition before branch refresh", () => {
  const working = operation();
  const completed: AsyncAskOperation = {
    ...working,
    status: "completed",
    childSession: "/tmp/child.jsonl",
    result: { content: "answer", details: {} },
  };

  assert.equal(
    buildOperationFooter(
      [customEntry("working", working)],
      working.originSession,
      completed,
    ),
    undefined,
  );
});

test("formatAskOperation bounds and sanitizes durable details", () => {
  const text = formatAskOperation(
    operation({
      question: `Inspect data:image/png;base64,AAABBB== ${"x".repeat(300)}`,
      requestedModel: "anthropic/claude-sonnet",
      contextCharacters: 60_000,
      contextTruncated: true,
      readOnlyPolicy: "harness-tools",
      promptSha256: "a".repeat(64),
      failure: {
        reason: "prompt_failed",
        message: "failed\nwith another line",
      },
    }),
  );

  assert.match(text, /durable, not live/);
  assert.match(text, /\[base64 data omitted\]/);
  assert.doesNotMatch(text, /AAABBB|\nwith another line/);
  assert.match(text, /Question: .*…/);
  assert.match(text, /Requested model: anthropic\/claude-sonnet/);
  assert.match(text, /Context: 60000 characters \(truncated\)/);
  assert.match(text, /Read-only policy: harness-tools/);
  assert.match(text, /Prompt SHA-256: a{64}/);
});

test("formatPassReceipt exposes bounded approved state without payloads", () => {
  const text = formatPassReceipt(
    passReceipt({
      approvedPrompt: "Approved data:image/png;base64,AAABBB== prompt",
      cwd: `/tmp/data:image/png;base64,CCCDDD==\n${"x".repeat(600)}`,
    }),
  );

  assert.match(text, /Delivery: approved \(durable, not live\)/);
  assert.match(
    text,
    /Approved prompt: Approved \[base64 data omitted\] prompt/,
  );
  assert.doesNotMatch(text, /AAABBB|CCCDDD/);
  const cwdLine = text
    .split("\n")
    .find((line) => line.startsWith("Working directory:"));
  assert.match(
    cwdLine ?? "",
    /Working directory: \/tmp\/\[base64 data omitted\] x+…$/,
  );
  assert.ok(
    (cwdLine?.length ?? Number.POSITIVE_INFINITY) <=
      "Working directory: ".length + 501,
  );
});

test("resolveOperation includes Pass receipts", () => {
  const receipt = passReceipt();
  const resolution = resolveOperation(
    [passEntry("pass", receipt)],
    receipt.originSession,
    receipt.operationId,
  );

  assert.equal(resolution.status, "found");
  assert.equal(
    resolution.status === "found" ? resolution.operation.kind : undefined,
    "pass",
  );
});

test("status lists only current-origin operations and focus uses an exact ID", async () => {
  const entries: SessionEntry[] = [
    customEntry("older", operation()),
    customEntry(
      "newer",
      operation({
        operationId: "operation-newer",
        createdAt: 2,
        updatedAt: 2,
        question: "Newer question",
      }),
    ),
    customEntry(
      "other",
      operation({
        operationId: "operation-other",
        originSession: "/tmp/other.jsonl",
        createdAt: 3,
        updatedAt: 3,
      }),
    ),
    passEntry("pass", passReceipt({ createdAt: 4, updatedAt: 4 })),
  ];
  const notifications: Array<{
    message: string;
    type: string | undefined;
  }> = [];
  const handlers = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  >();
  const focused: string[] = [];
  const pi = {
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => handlers.set(name, options.handler),
  } as unknown as ExtensionAPI;
  const createOrchestrator = (() => ({
    focus: async (agentName: string) => {
      focused.push(agentName);
    },
  })) as unknown as CreateOrchestrator;
  registerOperationCommands(pi, createOrchestrator);
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => entries,
      getSessionFile: () => "/tmp/origin.jsonl",
    },
    ui: {
      notify: (message: string, type?: string) =>
        notifications.push({ message, type }),
    },
  } as unknown as ExtensionCommandContext;

  await handlers.get("portr-status")?.("", ctx);
  assert.match(notifications[0]?.message ?? "", /pass-1 \| pass/);
  assert.match(notifications[0]?.message ?? "", /operation-newer/);
  assert.match(notifications[0]?.message ?? "", /operation-1/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /operation-other/);
  assert.ok(
    (notifications[0]?.message.indexOf("operation-newer") ?? -1) <
      (notifications[0]?.message.indexOf("operation-1") ?? -1),
  );

  await handlers.get("portr-focus")?.("operation-newer", ctx);
  assert.deepEqual(focused, ["portr-ask-test"]);

  await handlers.get("portr-focus")?.("operation", ctx);
  assert.deepEqual(focused, ["portr-ask-test"]);
  assert.match(
    notifications.at(-1)?.message ?? "",
    /no valid durable snapshot/,
  );
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
