import {
  buildSessionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ASYNC_ASK_RESULT_MESSAGE } from "./state.ts";

export const DEFAULT_CONTEXT_CHARACTER_LIMIT = 60_000;

const OMITTED_MESSAGES_MARKER = "[Earlier messages omitted due to size]";
const OMITTED_COMPACTION_MIDDLE_MARKER =
  "[Middle of compacted context omitted due to size]";
const DATA_URL_PATTERN = /data:[^,\s]*;base64,[a-zA-Z0-9+/=_%-]+/gi;

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
  validateLimit(maxCharacters);

  const context = buildSessionContext(
    sessionManager.getEntries(),
    sessionManager.getLeafId(),
  );
  const serialized = serializeTransferMessages(context.messages);
  if (serialized.length <= maxCharacters) {
    return {
      text: serialized,
      truncated: false,
      originalLength: serialized.length,
    };
  }

  const compactionIndex = context.messages.findLastIndex(
    (message) => isRecord(message) && message.role === "compactionSummary",
  );
  const compaction = serializeMessage(context.messages[compactionIndex]);
  if (compactionIndex < 0 || compaction === undefined) {
    return {
      text: boundTransferMessagesFromEnd(context.messages, maxCharacters),
      truncated: true,
      originalLength: serialized.length,
    };
  }
  if (compaction.length >= maxCharacters) {
    return {
      text: boundOversizedCompaction(compaction, maxCharacters),
      truncated: true,
      originalLength: serialized.length,
    };
  }

  const recentMessages = context.messages.filter(
    (_message, index) => index !== compactionIndex,
  );
  const recent = serializeTransferMessages(recentMessages);
  const available = maxCharacters - compaction.length - 2;
  if (available <= 0 || recent.length === 0) {
    return {
      text: compaction,
      truncated: true,
      originalLength: serialized.length,
    };
  }

  return {
    text: `${compaction}\n\n${boundTransferMessagesFromEnd(recentMessages, available)}`,
    truncated: true,
    originalLength: serialized.length,
  };
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
    case "custom": {
      if (
        message.customType !== ASYNC_ASK_RESULT_MESSAGE ||
        message.display !== true
      ) {
        return undefined;
      }
      const text = extractText(message.content);
      return text.length > 0 ? text : undefined;
    }
    default:
      return undefined;
  }
}

function boundTransferMessagesFromEnd(
  messages: readonly unknown[],
  maxCharacters: number,
): string {
  const sections = messages.flatMap((message) => {
    const text = serializeMessage(message);
    return text === undefined || !isRecord(message)
      ? []
      : [{ role: message.role, text }];
  });
  const serialized = sections.map((section) => section.text).join("\n\n");
  if (serialized.length <= maxCharacters) {
    return serialized;
  }

  const marker = `${OMITTED_MESSAGES_MARKER}\n\n`;
  const latest = sections.at(-1);
  if (latest === undefined) {
    return "";
  }
  if (marker.length >= maxCharacters) {
    return latest.role === "toolResult"
      ? OMITTED_MESSAGES_MARKER.slice(0, maxCharacters)
      : latest.text.slice(-maxCharacters);
  }

  const selected: typeof sections = [];
  let usedCharacters = marker.length;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section === undefined) {
      continue;
    }
    const separatorCharacters = selected.length === 0 ? 0 : 2;
    if (
      usedCharacters + separatorCharacters + section.text.length >
      maxCharacters
    ) {
      if (selected.length === 0) {
        return section.role === "toolResult"
          ? OMITTED_MESSAGES_MARKER
          : marker + section.text.slice(-(maxCharacters - marker.length));
      }
      break;
    }
    selected.unshift(section);
    usedCharacters += separatorCharacters + section.text.length;
  }

  while (selected[0]?.role === "toolResult") {
    selected.shift();
  }

  return selected.length === 0
    ? OMITTED_MESSAGES_MARKER
    : marker + selected.map((section) => section.text).join("\n\n");
}

function boundOversizedCompaction(
  compaction: string,
  maxCharacters: number,
): string {
  if (compaction.length <= maxCharacters) {
    return compaction;
  }

  const marker = `\n\n${OMITTED_COMPACTION_MIDDLE_MARKER}\n\n`;
  if (marker.length >= maxCharacters) {
    const headLength = Math.ceil(maxCharacters / 2);
    return (
      compaction.slice(0, headLength) +
      compaction.slice(-(maxCharacters - headLength))
    );
  }

  const contentCharacters = maxCharacters - marker.length;
  const headLength = Math.ceil(contentCharacters / 2);
  return (
    compaction.slice(0, headLength) +
    marker +
    compaction.slice(-(contentCharacters - headLength))
  );
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

export function quoteReferenceBlock(text: string): string {
  return sanitizeTransferText(text)
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
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
