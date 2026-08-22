import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AskResultError } from "./ask-result.ts";
import { sanitizeTransferText } from "./context.ts";
import type { AgentSessionReference } from "./orchestrator.ts";

export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
export const MAX_CLAUDE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export interface ClaudeLaunchOptions {
  readOnly: boolean;
  model?: string;
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

  return args;
}

export function resolveClaudeSessionReference(
  session: AgentSessionReference | undefined,
): string | undefined {
  return session?.agent === "claude" ? session.value : undefined;
}

export function resolveClaudeTranscriptPath(
  cwd: string,
  sessionId: string,
  home = homedir(),
): string {
  if (cwd.length === 0) {
    throw new Error("cwd must not be empty");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
  ) {
    throw new Error("Claude session ID must be a UUID");
  }

  const projectDirectory = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(
    home,
    ".claude",
    "projects",
    projectDirectory,
    `${sessionId}.jsonl`,
  );
}

export function extractClaudeTranscriptAnswer(transcript: string): string {
  const records: unknown[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new AskResultError(
        "Child Claude transcript contains invalid JSON",
        { cause: error },
      );
    }
  }

  let finalIndex = -1;
  let finalRecord: Record<string, unknown> | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      isRecord(record) &&
      record.type === "assistant" &&
      record.isSidechain !== true
    ) {
      finalIndex = index;
      finalRecord = record;
      break;
    }
  }

  if (finalRecord === undefined || !isRecord(finalRecord.message)) {
    throw new AskResultError(
      "Child Claude session contained no assistant answer",
    );
  }
  if (finalRecord.message.role !== "assistant") {
    throw new AskResultError(
      "Final Claude transcript record has an invalid role",
    );
  }
  if (finalRecord.message.stop_reason !== "end_turn") {
    throw new AskResultError(
      `Final Claude assistant message is incomplete (${String(finalRecord.message.stop_reason ?? "unknown")})`,
    );
  }
  if (
    typeof finalRecord.uuid !== "string" ||
    typeof finalRecord.message.id !== "string" ||
    !Array.isArray(finalRecord.message.content)
  ) {
    throw new AskResultError(
      "Final Claude assistant message has invalid content",
    );
  }

  const hasTurnCompletion = records
    .slice(finalIndex + 1)
    .some(
      (record) =>
        isRecord(record) &&
        record.type === "system" &&
        record.subtype === "turn_duration" &&
        record.parentUuid === finalRecord.uuid,
    );
  if (!hasTurnCompletion) {
    throw new AskResultError(
      "Child Claude transcript does not contain a durable turn completion marker",
    );
  }

  const messageId = finalRecord.message.id;
  const answer = sanitizeTransferText(
    records
      .flatMap((record) => {
        if (
          !isRecord(record) ||
          record.type !== "assistant" ||
          record.isSidechain === true ||
          !isRecord(record.message) ||
          record.message.id !== messageId ||
          !Array.isArray(record.message.content)
        ) {
          return [];
        }
        return record.message.content.flatMap((block) =>
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        );
      })
      .join("\n"),
  ).trim();

  if (answer.length === 0) {
    throw new AskResultError(
      "Final Claude assistant message contained no text",
    );
  }
  return answer;
}

export function extractClaudeSessionAnswer(
  sessionId: string,
  cwd: string,
): string {
  const transcriptPath = resolveClaudeTranscriptPath(cwd, sessionId);
  try {
    const stats = statSync(transcriptPath);
    if (!stats.isFile()) {
      throw new AskResultError("Child Claude transcript is not a regular file");
    }
    if (stats.size > MAX_CLAUDE_TRANSCRIPT_BYTES) {
      throw new AskResultError(
        `Child Claude transcript exceeds ${MAX_CLAUDE_TRANSCRIPT_BYTES} bytes`,
      );
    }
    return extractClaudeTranscriptAnswer(readFileSync(transcriptPath, "utf8"));
  } catch (error) {
    if (error instanceof AskResultError) {
      throw error;
    }
    throw new AskResultError("Could not open the child Claude session", {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
