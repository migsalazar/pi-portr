import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ASYNC_ASK_OPERATION_ENTRY = "portr-ask-operation";
export const ASYNC_ASK_RESULT_MESSAGE = "portr-ask-result";
export const ASYNC_ASK_STATE_VERSION = 1;

export const OPERATION_STATUSES = [
  "working",
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
  target: "pi" | "claude";
  status: OperationStatus;
  originSession: string;
  question: string;
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

export function isAsyncAskOperation(
  value: unknown,
): value is AsyncAskOperation {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.version !== ASYNC_ASK_STATE_VERSION ||
    value.kind !== "ask" ||
    (value.target !== "pi" && value.target !== "claude") ||
    !isOperationStatus(value.status) ||
    !isNonEmptyString(value.operationId) ||
    !isNonEmptyString(value.originSession) ||
    typeof value.question !== "string" ||
    (value.cwd !== undefined && !isNonEmptyString(value.cwd)) ||
    (value.target === "claude" && !isNonEmptyString(value.cwd)) ||
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

  if (value.status === "completed") {
    return value.result !== undefined && isNonEmptyString(value.childSession);
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

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
