import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AskResultError } from "./ask-result.ts";
import { sanitizeTransferText } from "./context.ts";
import type { AgentSessionReference } from "./orchestrator.ts";

export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface PiLaunchOptions {
  readOnly: boolean;
  model?: string;
}

export function buildPiLaunchArgs(options: PiLaunchOptions): string[] {
  const args: string[] = [];

  if (options.readOnly) {
    args.push("--tools", PI_READ_ONLY_TOOLS.join(","));
  }

  if (options.model !== undefined) {
    const model = options.model.trim();
    if (model.length === 0) {
      throw new Error("model must not be empty");
    }
    args.push("--model", model);
  }

  return args;
}

export function resolvePiSessionReference(
  session: AgentSessionReference | undefined,
): string | undefined {
  return session?.agent === "pi" ? session.value : undefined;
}

export function extractFinalPiAssistantAnswer(
  messages: readonly unknown[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    if (message.stopReason !== "stop") {
      throw new AskResultError(
        `Final assistant message is incomplete (${String(message.stopReason ?? "unknown")})`,
      );
    }
    if (!Array.isArray(message.content)) {
      throw new AskResultError("Final assistant message has invalid content");
    }

    const answer = sanitizeTransferText(
      message.content
        .flatMap((block) =>
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n"),
    ).trim();

    if (answer.length === 0) {
      throw new AskResultError("Final assistant message contained no text");
    }
    return answer;
  }

  throw new AskResultError("Child Pi session contained no assistant answer");
}

export function extractPiSessionAnswer(sessionPath: string): string {
  try {
    const session = SessionManager.open(sessionPath);
    return extractFinalPiAssistantAnswer(
      session.buildSessionContext().messages,
    );
  } catch (error) {
    if (error instanceof AskResultError) {
      throw error;
    }
    throw new AskResultError("Could not open the child Pi session", {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
