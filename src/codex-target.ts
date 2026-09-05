import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { AskResultError } from "./ask-result.ts";
import { boundText, sanitizeTransferText } from "./context.ts";
import type { AgentSessionReference } from "./orchestrator.ts";

const CODEX_EXECUTABLE = "codex";
const CODEX_APP_SERVER_TIMEOUT_MS = 10_000;
const MAX_CODEX_APP_SERVER_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_FAILURE_CHARACTERS = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CodexLaunchOptions {
  readOnly: boolean;
  model?: string;
}

export function buildCodexLaunchArgs(options: CodexLaunchOptions): string[] {
  const args = options.readOnly
    ? [
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "-c",
        'approvals_reviewer="user"',
      ]
    : [];

  args.push("-c", "check_for_update_on_startup=false");

  if (options.model !== undefined) {
    const model = options.model.trim();
    if (model.length === 0) {
      throw new Error("model must not be empty");
    }
    args.push("--model", model);
  }

  return args;
}

export function resolveCodexSessionReference(
  session: AgentSessionReference | undefined,
): string | undefined {
  return session?.agent === "codex" && UUID_PATTERN.test(session.value)
    ? session.value
    : undefined;
}

export async function extractCodexSessionAnswer(
  sessionId: string,
  expectedPromptSha256: string,
  readThread: (sessionId: string) => Promise<unknown> = readCodexThread,
): Promise<string> {
  validateUuid(sessionId, "Codex session ID");
  if (!SHA256_PATTERN.test(expectedPromptSha256)) {
    throw new Error("expected prompt SHA-256 must be lowercase hexadecimal");
  }

  return extractFinalCodexAssistantAnswer(
    await readThread(sessionId),
    sessionId,
    expectedPromptSha256,
  );
}

export function extractFinalCodexAssistantAnswer(
  result: unknown,
  sessionId: string,
  expectedPromptSha256: string,
): string {
  validateUuid(sessionId, "Codex session ID");
  if (!SHA256_PATTERN.test(expectedPromptSha256)) {
    throw new Error("expected prompt SHA-256 must be lowercase hexadecimal");
  }
  if (
    !isRecord(result) ||
    !isRecord(result.thread) ||
    result.thread.id !== sessionId ||
    !Array.isArray(result.thread.turns)
  ) {
    throw new AskResultError("Codex app server returned an invalid thread");
  }

  const matchingTurns = result.thread.turns.filter((turn) =>
    turnMatchesPrompt(turn, expectedPromptSha256),
  );
  if (matchingTurns.length === 0) {
    throw new AskResultError(
      "Codex session contained no turn for the submitted prompt",
    );
  }
  if (matchingTurns.length > 1) {
    throw new AskResultError(
      "Codex session contained multiple turns for the submitted prompt",
    );
  }

  const turn = matchingTurns[0];
  if (
    !isRecord(turn) ||
    (turn.status !== "completed" &&
      turn.status !== "interrupted" &&
      turn.status !== "failed" &&
      turn.status !== "inProgress")
  ) {
    throw new AskResultError("Codex turn has an invalid status");
  }
  if (turn.status !== "completed") {
    const detail =
      turn.status === "failed" &&
      isRecord(turn.error) &&
      typeof turn.error.message === "string"
        ? `: ${
            boundText(
              sanitizeTransferText(turn.error.message),
              MAX_CODEX_FAILURE_CHARACTERS,
            ).text
          }`
        : "";
    throw new AskResultError(`Codex turn ${turn.status}${detail}`);
  }
  if (!Array.isArray(turn.items)) {
    throw new AskResultError("Completed Codex turn has invalid items");
  }

  const finalMessages = turn.items.filter(
    (item) =>
      isRecord(item) &&
      item.type === "agentMessage" &&
      item.phase === "final_answer" &&
      typeof item.text === "string",
  );
  if (finalMessages.length !== 1) {
    throw new AskResultError(
      finalMessages.length === 0
        ? "Completed Codex turn contained no final answer"
        : "Completed Codex turn contained multiple final answers",
    );
  }

  const finalMessage = finalMessages[0];
  const answer = sanitizeTransferText(
    isRecord(finalMessage) && typeof finalMessage.text === "string"
      ? finalMessage.text
      : "",
  ).trim();
  if (answer.length === 0) {
    throw new AskResultError("Codex final answer contained no text");
  }
  return answer;
}

async function readCodexThread(sessionId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CODEX_EXECUTABLE,
      ["app-server", "--stdio", "-c", "check_for_update_on_startup=false"],
      { shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    let settled = false;
    let initialized = false;
    let stdout = "";
    let outputBytes = 0;

    const finish = (error: Error | undefined, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill();
      }
      if (error === undefined) {
        resolve(value);
      } else {
        reject(error);
      }
    };
    const fail = (message: string, cause?: unknown): void => {
      finish(new AskResultError(message, { cause }));
    };
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timeout = setTimeout(
      () => fail("Codex app server timed out while reading the child session"),
      CODEX_APP_SERVER_TIMEOUT_MS,
    );

    child.on("error", (error) => {
      fail("Could not start the Codex app server", error);
    });
    child.on("close", () => {
      if (!settled) {
        fail("Codex app server closed before returning the child session");
      }
    });
    child.stdin.on("error", (error) => {
      fail("Could not write to the Codex app server", error);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CODEX_APP_SERVER_OUTPUT_BYTES) {
        fail("Codex app server output exceeded the size limit");
      }
    });
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_CODEX_APP_SERVER_OUTPUT_BYTES) {
        fail("Codex app server output exceeded the size limit");
        return;
      }
      stdout += chunk;

      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (line.trim().length === 0) {
          continue;
        }

        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch (error) {
          fail("Codex app server returned invalid JSON", error);
          return;
        }
        if (!isRecord(message)) {
          fail("Codex app server returned an invalid response");
          return;
        }
        if (message.id === 1) {
          if (isRecord(message.error) || !isRecord(message.result)) {
            fail("Codex app server initialization failed");
            return;
          }
          if (!initialized) {
            initialized = true;
            send({ method: "initialized" });
            send({
              method: "thread/read",
              id: 2,
              params: { threadId: sessionId, includeTurns: true },
            });
          }
        } else if (message.id === 2) {
          if (isRecord(message.error) || !isRecord(message.result)) {
            fail("Codex app server could not read the child session");
            return;
          }
          finish(undefined, message.result);
          return;
        }
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "pi-portr",
          title: "pi-portr",
          version: "1.0.0",
        },
      },
    });
  });
}

function turnMatchesPrompt(
  value: unknown,
  expectedPromptSha256: string,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return false;
  }
  const userMessages = value.items.filter(
    (item) => isRecord(item) && item.type === "userMessage",
  );
  if (userMessages.length !== 1) {
    return false;
  }
  const userMessage = userMessages[0];
  if (!isRecord(userMessage) || !Array.isArray(userMessage.content)) {
    return false;
  }
  const textBlocks = userMessage.content.filter(
    (block) =>
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string",
  );
  if (textBlocks.length !== 1) {
    return false;
  }
  const block = textBlocks[0];
  return (
    isRecord(block) &&
    typeof block.text === "string" &&
    createHash("sha256").update(block.text, "utf8").digest("hex") ===
      expectedPromptSha256
  );
}

function validateUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
