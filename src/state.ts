import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ASYNC_ASK_OPERATION_ENTRY = "portr-ask-operation";
export const ASYNC_ASK_RESULT_MESSAGE = "portr-ask-result";
export const ASYNC_ASK_STATE_VERSION = 1;
export const PASS_RECEIPT_ENTRY = "portr-pass-receipt";
export const PASS_RECEIPT_STATE_VERSION = 1;

export const OPERATION_STATUSES = [
  "working",
  "blocked",
  "completed",
  "failed",
  "delivered",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const FAILURE_REASONS = [
  "prompt_failed",
  "timeout",
  "blocked",
  "ambiguous_status",
  "result_unavailable",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface StoredAskResult {
  content: string;
  details: Record<string, unknown>;
}

export interface AskOperationFailure {
  reason: FailureReason;
  message: string;
}

export interface AsyncAskOperation {
  version: typeof ASYNC_ASK_STATE_VERSION;
  kind: "ask";
  operationId: string;
  target: "pi" | "claude" | "codex";
  status: OperationStatus;
  originSession: string;
  question: string;
  noContext?: true;
  requestedModel?: string;
  contextCharacters?: number;
  contextTruncated?: true;
  readOnlyPolicy?: "harness-tools" | "codex-sandbox";
  promptSha256?: string;
  cwd?: string;
  agentName: string;
  paneId: string;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  childSession?: string;
  outcome?: "completed" | "failed";
  result?: StoredAskResult;
  failure?: AskOperationFailure;
}

export type PassDeliveryStatus = "approved" | "delivered" | "failed";
export type PassFocusStatus =
  | "not_attempted"
  | "focused"
  | "skipped"
  | "failed";
export type PassReceiptStage =
  | "approved"
  | "split"
  | "start"
  | "prompt"
  | "focus";

export interface PassReceipt {
  version: typeof PASS_RECEIPT_STATE_VERSION;
  kind: "pass";
  operationId: string;
  originSession: string;
  target: "pi" | "claude" | "codex";
  model?: string;
  cwd?: string;
  goal: string;
  approvedPrompt: string;
  deliveryStatus: PassDeliveryStatus;
  focusStatus: PassFocusStatus;
  launchStage: PassReceiptStage;
  agentName: string;
  paneId?: string;
  childSession?: string;
  failure?: { message: string };
  createdAt: number;
  updatedAt: number;
}

export function restoreAsyncAskOperations(
  entries: readonly SessionEntry[],
): Map<string, AsyncAskOperation> {
  const operations = new Map<string, AsyncAskOperation>();
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== ASYNC_ASK_OPERATION_ENTRY ||
      !isAsyncAskOperation(entry.data)
    ) {
      continue;
    }
    operations.set(entry.data.operationId, entry.data);
  }
  return operations;
}

export function restorePassReceipts(
  entries: readonly SessionEntry[],
): Map<string, PassReceipt> {
  const receipts = new Map<string, PassReceipt>();
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== PASS_RECEIPT_ENTRY ||
      !isPassReceipt(entry.data)
    ) {
      continue;
    }
    receipts.set(entry.data.operationId, entry.data);
  }
  return receipts;
}

export function isAsyncAskOperation(
  value: unknown,
): value is AsyncAskOperation {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.version !== ASYNC_ASK_STATE_VERSION ||
    value.kind !== "ask" ||
    (value.target !== "pi" &&
      value.target !== "claude" &&
      value.target !== "codex") ||
    !isOperationStatus(value.status) ||
    !isNonEmptyString(value.operationId) ||
    !isNonEmptyString(value.originSession) ||
    typeof value.question !== "string" ||
    (value.noContext !== undefined && value.noContext !== true) ||
    (value.requestedModel !== undefined &&
      !isNonEmptyString(value.requestedModel)) ||
    (value.contextCharacters !== undefined &&
      !isNonNegativeSafeInteger(value.contextCharacters)) ||
    (value.contextTruncated !== undefined && value.contextTruncated !== true) ||
    (value.readOnlyPolicy !== undefined &&
      value.readOnlyPolicy !== "harness-tools" &&
      value.readOnlyPolicy !== "codex-sandbox") ||
    (value.promptSha256 !== undefined && !isSha256(value.promptSha256)) ||
    (value.cwd !== undefined && !isNonEmptyString(value.cwd)) ||
    !isNonEmptyString(value.agentName) ||
    !isNonEmptyString(value.paneId) ||
    !isFiniteTimestamp(value.createdAt) ||
    !isFiniteTimestamp(value.updatedAt) ||
    !isFiniteTimestamp(value.deadlineAt) ||
    (value.childSession !== undefined &&
      !isNonEmptyString(value.childSession)) ||
    (value.outcome !== undefined &&
      value.outcome !== "completed" &&
      value.outcome !== "failed") ||
    (value.result !== undefined && !isStoredAskResult(value.result)) ||
    (value.failure !== undefined && !isAskOperationFailure(value.failure))
  ) {
    return false;
  }
  if (
    value.target === "codex" &&
    (value.readOnlyPolicy !== "codex-sandbox" ||
      value.promptSha256 === undefined)
  ) {
    return false;
  }

  if (value.status === "completed") {
    return value.result !== undefined && isNonEmptyString(value.childSession);
  }
  if (value.status === "blocked") {
    return (
      value.failure !== undefined &&
      value.result === undefined &&
      value.outcome === undefined
    );
  }
  if (value.status === "failed") {
    return value.result !== undefined && value.failure !== undefined;
  }
  if (value.status === "delivered") {
    return (
      value.result !== undefined &&
      (value.outcome === "completed" || value.outcome === "failed")
    );
  }
  return true;
}

export function isPassReceipt(value: unknown): value is PassReceipt {
  if (
    !isRecord(value) ||
    value.version !== PASS_RECEIPT_STATE_VERSION ||
    value.kind !== "pass" ||
    !isNonEmptyString(value.operationId) ||
    !isNonEmptyString(value.originSession) ||
    (value.target !== "pi" &&
      value.target !== "claude" &&
      value.target !== "codex") ||
    (value.model !== undefined && !isNonEmptyString(value.model)) ||
    (value.cwd !== undefined && !isNonEmptyString(value.cwd)) ||
    !isNonEmptyString(value.goal) ||
    !isNonEmptyString(value.approvedPrompt) ||
    !isPassDeliveryStatus(value.deliveryStatus) ||
    !isPassFocusStatus(value.focusStatus) ||
    !isPassReceiptStage(value.launchStage) ||
    !isNonEmptyString(value.agentName) ||
    (value.paneId !== undefined && !isNonEmptyString(value.paneId)) ||
    (value.childSession !== undefined &&
      !isNonEmptyString(value.childSession)) ||
    (value.failure !== undefined && !isPassReceiptFailure(value.failure)) ||
    !isFiniteTimestamp(value.createdAt) ||
    !isFiniteTimestamp(value.updatedAt)
  ) {
    return false;
  }

  if (value.deliveryStatus === "failed") {
    return (
      value.failure !== undefined &&
      value.focusStatus === "not_attempted" &&
      value.launchStage !== "approved"
    );
  }
  if (value.deliveryStatus === "approved") {
    return value.failure === undefined && value.focusStatus === "not_attempted";
  }
  if (value.paneId === undefined) {
    return false;
  }
  return value.focusStatus === "failed"
    ? value.failure !== undefined && value.launchStage === "focus"
    : value.failure === undefined;
}

function isStoredAskResult(value: unknown): value is StoredAskResult {
  return (
    isRecord(value) &&
    typeof value.content === "string" &&
    isRecord(value.details)
  );
}

function isAskOperationFailure(value: unknown): value is AskOperationFailure {
  return (
    isRecord(value) &&
    typeof value.reason === "string" &&
    FAILURE_REASONS.includes(value.reason as FailureReason) &&
    isNonEmptyString(value.message)
  );
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return (
    typeof value === "string" &&
    OPERATION_STATUSES.includes(value as OperationStatus)
  );
}

function isPassDeliveryStatus(value: unknown): value is PassDeliveryStatus {
  return value === "approved" || value === "delivered" || value === "failed";
}

function isPassFocusStatus(value: unknown): value is PassFocusStatus {
  return (
    value === "not_attempted" ||
    value === "focused" ||
    value === "skipped" ||
    value === "failed"
  );
}

function isPassReceiptStage(value: unknown): value is PassReceiptStage {
  return (
    value === "approved" ||
    value === "split" ||
    value === "start" ||
    value === "prompt" ||
    value === "focus"
  );
}

function isPassReceiptFailure(value: unknown): value is { message: string } {
  return isRecord(value) && isNonEmptyString(value.message);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
