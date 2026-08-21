export const OPERATION_STATUSES = [
  "working",
  "blocked",
  "completed",
  "failed",
  "delivered",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const FAILURE_REASONS = [
  "launch_failed",
  "prompt_failed",
  "timeout",
  "result_unavailable",
  "cancelled",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];
