import {
  buildSessionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_CONTEXT_CHARACTER_LIMIT = 60_000;

const OMITTED_CONTEXT_MARKER = "[Earlier context omitted due to size]";
const DATA_URL_PATTERN = /data:[^;\s]+;base64,[a-zA-Z0-9+/=_-]+/g;

type ContextSessionManager = Pick<SessionManager, "getEntries" | "getLeafId">;

export interface BoundedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export function boundText(text: string, maxCharacters: number): BoundedText {
  validateLimit(maxCharacters);

  return {
    text: text.slice(0, maxCharacters),
    truncated: text.length > maxCharacters,
    originalLength: text.length,
  };
}

export function boundTextFromEnd(
  text: string,
  maxCharacters: number,
): BoundedText {
  validateLimit(maxCharacters);

  if (text.length <= maxCharacters) {
    return {
      text,
      truncated: false,
      originalLength: text.length,
    };
  }

  const marker = `${OMITTED_CONTEXT_MARKER}\n\n`;
  const bounded =
    marker.length < maxCharacters
      ? marker + text.slice(-(maxCharacters - marker.length))
      : text.slice(-maxCharacters);

  return {
    text: bounded,
    truncated: true,
    originalLength: text.length,
  };
}

export function serializeTransferMessages(
  messages: readonly unknown[],
): string {
  const sections: string[] = [];

  for (const message of messages) {
    const section = serializeMessage(message);
    if (section !== undefined) {
      sections.push(section);
    }
  }

  return sections.join("\n\n");
}

export function buildTransferContext(
  sessionManager: ContextSessionManager,
  maxCharacters = DEFAULT_CONTEXT_CHARACTER_LIMIT,
): BoundedText {
  const context = buildSessionContext(
    sessionManager.getEntries(),
    sessionManager.getLeafId(),
  );
  return boundTextFromEnd(
    serializeTransferMessages(context.messages),
    maxCharacters,
  );
}

function serializeMessage(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.role !== "string") {
    return undefined;
  }

  switch (message.role) {
    case "user":
      return serializeTextMessage("User", message.content);
    case "assistant":
      return serializeAssistantMessage(message);
    case "toolResult": {
      const toolName =
        typeof message.toolName === "string" ? ` ${message.toolName}` : "";
      const outcome = message.isError === true ? "error" : "completed";
      return `[Tool${toolName}: ${outcome}; output omitted]`;
    }
    case "compactionSummary":
      return serializeSummary("Compacted context", message.summary);
    case "branchSummary":
      return serializeSummary("Branch summary", message.summary);
    default:
      return undefined;
  }
}

function serializeAssistantMessage(
  message: Record<string, unknown>,
): string | undefined {
  if (!Array.isArray(message.content)) {
    return undefined;
  }

  const text = extractText(message.content);
  const toolCalls = extractToolCalls(message.content);
  const parts: string[] = [];

  if (text.length > 0) {
    parts.push(`Assistant: ${text}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`[Assistant tools: ${toolCalls.join(", ")}]`);
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function serializeTextMessage(
  label: string,
  content: unknown,
): string | undefined {
  const text = sanitizeTransferText(extractText(content));
  return text.length > 0 ? `${label}: ${text}` : undefined;
}

function serializeSummary(label: string, summary: unknown): string | undefined {
  if (typeof summary !== "string") {
    return undefined;
  }

  const text = sanitizeTransferText(summary).trim();
  return text.length > 0 ? `${label}:\n${text}` : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return sanitizeTransferText(content).trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) => {
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        return [sanitizeTransferText(block.text)];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function extractToolCalls(content: readonly unknown[]): string[] {
  return content.flatMap((block) => {
    if (
      !isRecord(block) ||
      block.type !== "toolCall" ||
      typeof block.name !== "string"
    ) {
      return [];
    }

    const path = extractToolPath(block.arguments);
    return [path === undefined ? block.name : `${block.name}(${path})`];
  });
}

function extractToolPath(argumentsValue: unknown): string | undefined {
  if (!isRecord(argumentsValue)) {
    return undefined;
  }

  for (const key of ["path", "file_path"] as const) {
    const value = argumentsValue[key];
    if (typeof value === "string" && value.length > 0) {
      return sanitizeTransferText(value).slice(0, 500);
    }
  }

  return undefined;
}

export function sanitizeTransferText(text: string): string {
  return text.replace(DATA_URL_PATTERN, "[base64 data omitted]");
}

function validateLimit(maxCharacters: number): void {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError("maxCharacters must be a positive safe integer");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
