import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

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
