import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { boundText, sanitizeTransferText } from "../context.ts";
import type { CreateOrchestrator } from "../orchestrator.ts";
import {
  type AsyncAskOperation,
  type PassReceipt,
  restoreAsyncAskOperations,
  restorePassReceipts,
} from "../state.ts";

const SUMMARY_EXCERPT_CHARACTERS = 240;
const DETAIL_EXCERPT_CHARACTERS = 500;

type DurableOperation = AsyncAskOperation | PassReceipt;
export type OperationResolution<T extends DurableOperation = DurableOperation> =
  | { status: "found"; operation: T }
  | { status: "other_origin" }
  | { status: "missing" };

export function buildOperationFooter(
  entries: readonly SessionEntry[],
  originSession: string | undefined,
  latest?: AsyncAskOperation,
): string | undefined {
  if (originSession === undefined) {
    return undefined;
  }
  const operations = restoreAsyncAskOperations(entries);
  if (latest?.originSession === originSession) {
    operations.set(latest.operationId, latest);
  }
  let active = 0;
  let blocked = 0;
  for (const operation of operations.values()) {
    if (operation.originSession !== originSession) {
      continue;
    }
    if (operation.status === "working") {
      active += 1;
    } else if (operation.status === "blocked") {
      blocked += 1;
    }
  }
  const counts = [
    active === 0 ? undefined : `${active} active`,
    blocked === 0 ? undefined : `${blocked} blocked`,
  ].filter((value) => value !== undefined);
  return counts.length === 0 ? undefined : `portr: ${counts.join(", ")}`;
}

export function updateOperationFooter(
  ctx: ExtensionContext,
  latest?: AsyncAskOperation,
): void {
  ctx.ui.setStatus(
    "portr",
    buildOperationFooter(
      ctx.sessionManager.getBranch(),
      ctx.sessionManager.getSessionFile(),
      latest,
    ),
  );
}

export function registerOperationCommands(
  pi: ExtensionAPI,
  createOrchestrator: CreateOrchestrator,
): void {
  pi.registerCommand("portr-status", {
    description: "Show durable Portr operation state",
    handler: async (args, ctx) => {
      showOperationStatus(args, ctx);
    },
  });

  pi.registerCommand("portr-focus", {
    description: "Focus a durable Portr operation destination",
    handler: async (args, ctx) => {
      await focusOperation(args, ctx, createOrchestrator);
    },
  });
}

export function resolveAskOperation(
  entries: readonly SessionEntry[],
  originSession: string | undefined,
  operationId: string,
): OperationResolution<AsyncAskOperation> {
  const operation = restoreAsyncAskOperations(entries).get(operationId);
  if (operation !== undefined) {
    return operation.originSession === originSession
      ? { status: "found", operation }
      : { status: "other_origin" };
  }
  return { status: "missing" };
}

export function resolveOperation(
  entries: readonly SessionEntry[],
  originSession: string | undefined,
  operationId: string,
): OperationResolution {
  const ask = resolveAskOperation(entries, originSession, operationId);
  if (ask.status !== "missing") {
    return ask;
  }

  const receipt = restorePassReceipts(entries).get(operationId);
  if (receipt !== undefined) {
    return receipt.originSession === originSession
      ? { status: "found", operation: receipt }
      : { status: "other_origin" };
  }
  return { status: "missing" };
}

export function formatOperation(operation: DurableOperation): string {
  return operation.kind === "ask"
    ? formatAskOperation(operation)
    : formatPassReceipt(operation);
}

export function formatAskOperation(operation: AsyncAskOperation): string {
  const lines = [
    `Ask ${oneLine(operation.operationId, 100)}`,
    `State: ${operation.status} (durable, not live)`,
    `Target: ${operation.target}`,
    `Destination: ${oneLine(operation.agentName, 100)} (${oneLine(operation.paneId, 100)})`,
    `Created: ${formatTimestamp(operation.createdAt)}`,
    `Updated: ${formatTimestamp(operation.updatedAt)}`,
    `Question: ${oneLine(operation.question, SUMMARY_EXCERPT_CHARACTERS)}`,
  ];
  if (operation.requestedModel !== undefined) {
    lines.push(
      `Requested model: ${oneLine(operation.requestedModel, DETAIL_EXCERPT_CHARACTERS)}`,
    );
  }
  if (operation.contextCharacters !== undefined) {
    lines.push(
      operation.noContext === true
        ? "Context: none (--no-context)"
        : `Context: ${operation.contextCharacters} characters${operation.contextTruncated === true ? " (truncated)" : ""}`,
    );
  }
  if (operation.readOnlyPolicy !== undefined) {
    lines.push(`Read-only policy: ${operation.readOnlyPolicy}`);
  }
  if (operation.promptSha256 !== undefined) {
    lines.push(`Prompt SHA-256: ${operation.promptSha256}`);
  }
  if (operation.childSession !== undefined) {
    lines.push(
      `Child session: ${oneLine(operation.childSession, DETAIL_EXCERPT_CHARACTERS)}`,
    );
  }
  if (operation.failure !== undefined) {
    lines.push(
      `Failure: ${operation.failure.reason}: ${oneLine(operation.failure.message, DETAIL_EXCERPT_CHARACTERS)}`,
    );
  }
  return lines.join("\n");
}

export function formatPassReceipt(receipt: PassReceipt): string {
  const lines = [
    `Pass ${oneLine(receipt.operationId, 100)}`,
    `Delivery: ${receipt.deliveryStatus} (durable, not live)`,
    `Focus: ${receipt.focusStatus}`,
    `Launch stage: ${receipt.launchStage}`,
    `Target: ${receipt.target}${receipt.model === undefined ? "" : ` (${oneLine(receipt.model, 100)})`}`,
    `Destination: ${oneLine(receipt.agentName, 100)}${receipt.paneId === undefined ? "" : ` (${oneLine(receipt.paneId, 100)})`}`,
    `Created: ${formatTimestamp(receipt.createdAt)}`,
    `Updated: ${formatTimestamp(receipt.updatedAt)}`,
    `Goal: ${oneLine(receipt.goal, SUMMARY_EXCERPT_CHARACTERS)}`,
    `Approved prompt: ${oneLine(receipt.approvedPrompt, DETAIL_EXCERPT_CHARACTERS)}`,
  ];
  if (receipt.childSession !== undefined) {
    lines.push(
      `Child session: ${oneLine(receipt.childSession, DETAIL_EXCERPT_CHARACTERS)}`,
    );
  }
  if (receipt.failure !== undefined) {
    lines.push(
      `Failure: ${receipt.launchStage}: ${oneLine(receipt.failure.message, DETAIL_EXCERPT_CHARACTERS)}`,
    );
  }
  return lines.join("\n");
}

function showOperationStatus(
  rawArguments: string,
  ctx: ExtensionCommandContext,
): void {
  const operationId = parseOptionalOperationId(rawArguments, "portr-status");
  if (operationId instanceof Error) {
    ctx.ui.notify(operationId.message, "error");
    return;
  }

  const entries = ctx.sessionManager.getBranch();
  const originSession = ctx.sessionManager.getSessionFile();
  if (operationId !== undefined) {
    const resolution = resolveOperation(entries, originSession, operationId);
    if (resolution.status !== "found") {
      ctx.ui.notify(resolutionError(operationId, resolution.status), "error");
      return;
    }
    ctx.ui.notify(formatOperation(resolution.operation), "info");
    return;
  }

  const operations: DurableOperation[] = [
    ...restoreAsyncAskOperations(entries).values(),
    ...restorePassReceipts(entries).values(),
  ];
  const current = operations
    .filter((operation) => operation.originSession === originSession)
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        left.operationId.localeCompare(right.operationId),
    );
  if (current.length === 0) {
    ctx.ui.notify(
      "No durable Portr operations in the current origin session",
      "info",
    );
    return;
  }

  ctx.ui.notify(
    [
      "Durable Portr operation state (not live):",
      ...current.map(formatOperationSummary),
    ].join("\n"),
    "info",
  );
}

async function focusOperation(
  rawArguments: string,
  ctx: ExtensionCommandContext,
  createOrchestrator: CreateOrchestrator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/portr-focus requires interactive mode", "error");
    return;
  }

  const operationId = parseRequiredOperationId(rawArguments, "portr-focus");
  if (operationId instanceof Error) {
    ctx.ui.notify(operationId.message, "error");
    return;
  }
  const resolution = resolveOperation(
    ctx.sessionManager.getBranch(),
    ctx.sessionManager.getSessionFile(),
    operationId,
  );
  if (resolution.status !== "found") {
    ctx.ui.notify(resolutionError(operationId, resolution.status), "error");
    return;
  }

  try {
    await createOrchestrator().focus(resolution.operation.agentName);
    ctx.ui.notify(
      `Focused ${resolution.operation.agentName} for ${operationId}`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not focus ${resolution.operation.agentName}: ${errorMessage(error)}`,
      "error",
    );
  }
}

function formatOperationSummary(operation: DurableOperation): string {
  const summary =
    operation.kind === "ask" ? operation.question : operation.goal;
  const status =
    operation.kind === "ask"
      ? operation.status
      : `${operation.deliveryStatus}/${operation.focusStatus}`;
  return `${oneLine(operation.operationId, 100)} | ${operation.kind} | ${status} | ${operation.target} | ${oneLine(summary, SUMMARY_EXCERPT_CHARACTERS)}`;
}

function parseOptionalOperationId(
  input: string,
  command: string,
): string | undefined | Error {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return new Error(`Usage: /${command} [operation-id]`);
  }
  return tokens[0];
}

function parseRequiredOperationId(
  input: string,
  command: string,
): string | Error {
  const operationId = parseOptionalOperationId(input, command);
  return operationId === undefined
    ? new Error(`Usage: /${command} <operation-id>`)
    : operationId;
}

function resolutionError(
  operationId: string,
  status: Exclude<OperationResolution["status"], "found">,
): string {
  const detail =
    status === "other_origin"
      ? "belongs to another origin session"
      : "has no valid durable snapshot on the active branch";
  return `Operation ${oneLine(operationId, 100)} ${detail}`;
}

function oneLine(text: string, maxCharacters: number): string {
  const clean = sanitizeTransferText(text).replace(/\s+/g, " ").trim();
  const bounded = boundText(clean, maxCharacters);
  return bounded.text + (bounded.truncated ? "…" : "");
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
