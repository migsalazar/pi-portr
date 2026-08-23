import { createHash } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AskResultError } from "./ask-result.ts";
import { boundText, sanitizeTransferText } from "./context.ts";
import type { AgentSessionReference } from "./orchestrator.ts";

export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
export const MAX_CLAUDE_RECEIPT_BYTES = 64 * 1024 * 1024;

const CLAUDE_RECEIPT_VERSION = 1;
const CLAUDE_HOOK_TIMEOUT_SECONDS = 5;
const MAX_CLAUDE_FAILURE_CHARACTERS = 1_000;
const CLAUDE_HOOK_PATH = fileURLToPath(
  new URL("./claude-hook.mjs", import.meta.url),
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeAskReceiptLaunch {
  settings: string;
}

export interface ClaudeLaunchOptions {
  readOnly: boolean;
  model?: string;
  askReceipt?: ClaudeAskReceiptLaunch;
}

export function buildClaudeLaunchArgs(options: ClaudeLaunchOptions): string[] {
  const args: string[] = [];

  if (options.readOnly) {
    args.push(
      "--tools",
      CLAUDE_READ_ONLY_TOOLS.join(","),
      "--disallowedTools",
      "mcp__*",
      "--permission-mode",
      "dontAsk",
    );
  }

  if (options.model !== undefined) {
    const model = options.model.trim();
    if (model.length === 0) {
      throw new Error("model must not be empty");
    }
    args.push("--model", model);
  }

  if (options.askReceipt !== undefined) {
    if (options.askReceipt.settings.length === 0) {
      throw new Error("Claude ask receipt settings must not be empty");
    }
    args.push("--settings", options.askReceipt.settings);
  }

  return args;
}

export function prepareClaudeAskReceipt(
  operationId: string,
  prompt: string,
): ClaudeAskReceiptLaunch {
  validateUuid(operationId, "operation ID");
  if (prompt.length === 0) {
    throw new Error("Claude ask prompt must not be empty");
  }

  const receiptPath = resolveClaudeAskReceiptPath(operationId);
  const receipt = {
    version: CLAUDE_RECEIPT_VERSION,
    operationId,
    expectedPromptSha256: createHash("sha256")
      .update(prompt, "utf8")
      .digest("hex"),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  const handler = {
    type: "command",
    command: process.execPath,
    args: [CLAUDE_HOOK_PATH, receiptPath],
    timeout: CLAUDE_HOOK_TIMEOUT_SECONDS,
  };
  return {
    settings: JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [handler] }],
        Stop: [{ hooks: [handler] }],
        StopFailure: [{ hooks: [handler] }],
      },
    }),
  };
}

export function resolveClaudeAskReceiptPath(operationId: string): string {
  validateUuid(operationId, "operation ID");
  return join(tmpdir(), `pi-portr-ask-${operationId}.json`);
}

export function cleanupClaudeAskReceipt(operationId: string): void {
  const receiptPath = resolveClaudeAskReceiptPath(operationId);
  try {
    unlinkSync(receiptPath);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export function extractClaudeReceiptAnswer(
  operationId: string,
  sessionId: string,
): string {
  validateUuid(operationId, "operation ID");
  validateUuid(sessionId, "Claude session ID");
  const receiptPath = resolveClaudeAskReceiptPath(operationId);

  let receipt: unknown;
  try {
    const stats = statSync(receiptPath);
    if (!stats.isFile()) {
      throw new AskResultError("Claude ask receipt is not a regular file");
    }
    if (stats.size > MAX_CLAUDE_RECEIPT_BYTES) {
      throw new AskResultError(
        `Claude ask receipt exceeds ${MAX_CLAUDE_RECEIPT_BYTES} bytes`,
      );
    }
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    if (error instanceof AskResultError) {
      throw error;
    }
    throw new AskResultError("Could not open the Claude ask receipt", {
      cause: error,
    });
  }

  if (
    !isRecord(receipt) ||
    receipt.version !== CLAUDE_RECEIPT_VERSION ||
    receipt.operationId !== operationId ||
    typeof receipt.expectedPromptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(receipt.expectedPromptSha256)
  ) {
    throw new AskResultError("Claude ask receipt has an invalid schema");
  }
  if (typeof receipt.protocolError === "string") {
    throw new AskResultError(
      boundText(
        sanitizeTransferText(receipt.protocolError),
        MAX_CLAUDE_FAILURE_CHARACTERS,
      ).text,
    );
  }
  if (!isBinding(receipt.binding)) {
    throw new AskResultError(
      "Claude did not bind the submitted prompt to an ask receipt",
    );
  }
  if (receipt.binding.sessionId !== sessionId) {
    throw new AskResultError(
      "Claude ask receipt belongs to a different session",
    );
  }
  if (!isRecord(receipt.terminal)) {
    throw new AskResultError("Claude ask receipt has no terminal result");
  }
  if (
    receipt.terminal.sessionId !== receipt.binding.sessionId ||
    receipt.terminal.promptId !== receipt.binding.promptId
  ) {
    throw new AskResultError(
      "Claude ask receipt terminal result does not match its prompt",
    );
  }
  if (receipt.terminal.kind === "failed") {
    const error = boundText(
      sanitizeTransferText(
        typeof receipt.terminal.error === "string"
          ? receipt.terminal.error
          : "unknown",
      ),
      MAX_CLAUDE_FAILURE_CHARACTERS,
    ).text;
    const details =
      typeof receipt.terminal.errorDetails === "string"
        ? `: ${
            boundText(
              sanitizeTransferText(receipt.terminal.errorDetails),
              MAX_CLAUDE_FAILURE_CHARACTERS,
            ).text
          }`
        : "";
    throw new AskResultError(`Claude turn failed (${error})${details}`);
  }
  if (
    receipt.terminal.kind !== "completed" ||
    typeof receipt.terminal.lastAssistantMessage !== "string"
  ) {
    throw new AskResultError(
      "Claude ask receipt has an invalid terminal result",
    );
  }

  const answer = sanitizeTransferText(
    receipt.terminal.lastAssistantMessage,
  ).trim();
  if (answer.length === 0) {
    throw new AskResultError("Claude assistant message contained no text");
  }
  return answer;
}

export function resolveClaudeSessionReference(
  session: AgentSessionReference | undefined,
): string | undefined {
  return session?.agent === "claude" ? session.value : undefined;
}

function isBinding(value: unknown): value is {
  sessionId: string;
  promptId: string;
} {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.promptId === "string"
  );
}

function validateUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

function isNodeError(value: unknown): value is Error & { code: string } {
  return (
    value instanceof Error && "code" in value && typeof value.code === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
