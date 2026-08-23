import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const MAX_BYTES = 64 * 1024 * 1024;
const receiptPath = process.argv[2];

try {
  if (receiptPath === undefined) {
    throw new Error("Claude receipt path is required");
  }

  const input = await readInput();
  const receipt = readReceipt(receiptPath);
  if (receipt === undefined) {
    process.exit(0);
  }

  const event = JSON.parse(input);
  if (!isRecord(event) || typeof event.hook_event_name !== "string") {
    throw new Error("Claude hook input is invalid");
  }

  if (event.hook_event_name === "UserPromptSubmit") {
    handlePrompt(receiptPath, receipt, event);
  } else if (event.hook_event_name === "Stop") {
    handleStop(receiptPath, receipt, event);
  } else if (event.hook_event_name === "StopFailure") {
    handleStopFailure(receiptPath, receipt, event);
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_BYTES) {
      throw new Error("Claude hook input exceeds the size limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readReceipt(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_BYTES) {
      throw new Error("Claude receipt is invalid or too large");
    }
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isRecord(receipt) ||
      receipt.version !== 1 ||
      typeof receipt.operationId !== "string" ||
      typeof receipt.expectedPromptSha256 !== "string"
    ) {
      throw new Error("Claude receipt has an invalid schema");
    }
    return receipt;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function handlePrompt(path, receipt, event) {
  if (typeof event.prompt !== "string") {
    return;
  }
  const hash = createHash("sha256").update(event.prompt, "utf8").digest("hex");
  if (hash !== receipt.expectedPromptSha256 || receipt.binding !== undefined) {
    return;
  }
  if (
    typeof event.session_id !== "string" ||
    typeof event.prompt_id !== "string"
  ) {
    writeReceipt(path, {
      ...receipt,
      protocolError: "Claude Code did not provide session_id and prompt_id",
    });
    return;
  }
  writeReceipt(path, {
    ...receipt,
    binding: {
      sessionId: event.session_id,
      promptId: event.prompt_id,
    },
  });
}

function handleStop(path, receipt, event) {
  if (!matchesBinding(receipt.binding, event)) {
    return;
  }
  writeTerminal(path, receipt, {
    kind: "completed",
    sessionId: event.session_id,
    promptId: event.prompt_id,
    lastAssistantMessage: event.last_assistant_message,
  });
}

function handleStopFailure(path, receipt, event) {
  if (!matchesBinding(receipt.binding, event)) {
    return;
  }
  writeTerminal(path, receipt, {
    kind: "failed",
    sessionId: event.session_id,
    promptId: event.prompt_id,
    error: typeof event.error === "string" ? event.error : "unknown",
    ...(typeof event.error_details === "string"
      ? { errorDetails: event.error_details }
      : {}),
  });
}

function writeTerminal(path, receipt, terminal) {
  const next = { ...receipt, terminal };
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_BYTES) {
    writeReceipt(path, next, serialized);
    return;
  }
  writeReceipt(path, {
    ...receipt,
    terminal: {
      kind: "failed",
      sessionId: terminal.sessionId,
      promptId: terminal.promptId,
      error: "receipt_too_large",
      errorDetails: `Claude receipt exceeds ${MAX_BYTES} bytes`,
    },
  });
}

function writeReceipt(path, receipt, serialized = JSON.stringify(receipt)) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${serialized}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort: the receipt write or rename result is authoritative.
    }
  }
}

function matchesBinding(binding, event) {
  return (
    isRecord(binding) &&
    typeof event.session_id === "string" &&
    typeof event.prompt_id === "string" &&
    event.session_id === binding.sessionId &&
    event.prompt_id === binding.promptId
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isNodeError(value) {
  return value instanceof Error && "code" in value;
}
