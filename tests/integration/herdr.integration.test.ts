import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AskLaunchError,
  retryAskResultExtraction,
} from "../../src/async-ask.ts";
import {
  cleanupClaudeAskReceipt,
  type ClaudeAskReceiptLaunch,
  extractClaudeReceiptAnswer,
  prepareClaudeAskReceipt,
  resolveClaudeSessionReference,
} from "../../src/claude-target.ts";
import {
  extractCodexSessionAnswer,
  resolveCodexSessionReference,
} from "../../src/codex-target.ts";
import { buildAskPrompt, launchAsk } from "../../src/commands/ask.ts";
import { buildTransferContext } from "../../src/context.ts";
import { launchPass } from "../../src/commands/pass.ts";
import { HerdrClient } from "../../src/herdr.ts";
import type { AgentState, AgentStatus } from "../../src/orchestrator.ts";
import {
  extractPiSessionAnswer,
  resolvePiSessionReference,
} from "../../src/pi-target.ts";

type IntegrationTarget = "pi" | "claude" | "codex";
type IntegrationScenario =
  | "marker"
  | "short"
  | "long"
  | "tools"
  | "fidelity"
  | "selection"
  | "boundary";

const RUN_MODEL_INTEGRATION = process.env.PORTR_RUN_MODEL_INTEGRATION === "1";
const DEFAULT_TIMEOUT_MS = 180_000;
const BOUNDARY_CONTEXT_CHARACTERS = 60_000;
const BOUNDARY_PROMPT_CHARACTERS = 90_000;
const BOUNDARY_CONTEXT_LINES = 14_718;
const PACKAGE_VERSION = readPackageVersion();

test("Claude selection prompt preserves the intended transfer facts", () => {
  const prompt = buildSelectionPrompt();

  assert.match(prompt, /Deployment target: staging/);
  assert.match(prompt, /Keep automatic retries disabled/);
  assert.match(prompt, /Current objective: verify the selected policy/);
  assert.doesNotMatch(prompt, /Superseded implementation detail/);
  assert.doesNotMatch(prompt, /Prior Portr consultation:/);
});

test("Claude boundary prompt preserves maximum context without per-line overhead", () => {
  const marker = "PORTR_INTEGRATION_00000000_0000_0000_0000_000000000000";
  const prompt = buildBoundaryPrompt(marker);

  assert.ok(prompt.length < BOUNDARY_CONTEXT_CHARACTERS + 1_000);
  assert.equal(Buffer.byteLength(prompt, "utf8"), prompt.length);
  assert.doesNotMatch(prompt, /^> /m);
  assert.match(prompt, new RegExp(`${marker}_BEGIN`));
  assert.match(prompt, new RegExp(`${marker}_MIDDLE`));
  assert.match(prompt, new RegExp(`${marker}_END`));
});

test("Ask failure diagnostics preserve available destination references", () => {
  const diagnostics: string[] = [];
  const error = new AskLaunchError(
    "prompt_wait",
    "portr-integration-test",
    "w1:p2",
    new Error("destination blocked"),
    {
      status: "blocked",
      paneId: "w1:p2",
      session: {
        agent: "claude",
        kind: "id",
        value: "12345678-1234-1234-1234-123456789abc",
      },
    },
  );

  diagnoseAskLaunchError((message) => diagnostics.push(message), error);

  assert.deepEqual(diagnostics, [
    "pane: w1:p2",
    "session: 12345678-1234-1234-1234-123456789abc",
    "destination pane intentionally preserved",
  ]);
});

test("live Herdr destination acknowledges one prompt and yields a durable answer", {
  skip: RUN_MODEL_INTEGRATION
    ? false
    : "set PORTR_RUN_MODEL_INTEGRATION=1 to permit a paid model call",
  timeout: 240_000,
}, async (context) => {
  assert.equal(
    process.env.HERDR_ENV,
    "1",
    "integration tests must run inside a Herdr-managed pane",
  );

  const target = readChoice("PORTR_INTEGRATION_TARGET", [
    "pi",
    "claude",
    "codex",
  ] as const);
  const flow = readChoice("PORTR_INTEGRATION_FLOW", ["pass", "ask"] as const);
  const timeoutMs = readTimeout();
  const model = readOptionalEnvironment("PORTR_INTEGRATION_MODEL");
  const scenario = readChoiceWithDefault(
    "PORTR_INTEGRATION_SCENARIO",
    [
      "marker",
      "short",
      "long",
      "tools",
      "fidelity",
      "selection",
      "boundary",
    ] as const,
    "marker",
  );
  if (
    scenario === "fidelity" ||
    scenario === "selection" ||
    scenario === "boundary"
  ) {
    assert.equal(flow, "ask", `${scenario} requires the Ask flow`);
  }
  const operationId = randomUUID();
  const marker = `PORTR_INTEGRATION_${operationId.replaceAll("-", "_")}`;
  const agentName = `portr-integration-${operationId.slice(0, 8)}`;
  const prompt = buildPrompt(scenario, marker);
  const claudeReceipt =
    target === "claude" && flow === "ask"
      ? prepareClaudeAskReceipt(operationId, prompt)
      : undefined;
  if (claudeReceipt !== undefined) {
    context.after(() => cleanupClaudeAskReceipt(operationId));
  }
  const cwd = process.cwd();
  const herdr = new HerdrClient();
  const originPaneId = await herdr.currentPane();

  const launchOptions = {
    originPaneId,
    cwd,
    agentName,
    prompt,
    timeoutMs,
    operationId,
    ...(model === undefined ? {} : { model }),
    ...(claudeReceipt === undefined ? {} : { claudeReceipt }),
  };
  context.diagnostic(`target: ${target}`);
  context.diagnostic(`flow: ${flow}`);
  context.diagnostic(`scenario: ${scenario}`);
  context.diagnostic(`marker: ${marker}`);
  context.diagnostic(`agent: ${agentName}`);
  context.diagnostic(
    `prompt UTF-8 bytes: ${Buffer.byteLength(prompt, "utf8")}`,
  );
  context.diagnostic(
    `prompt SHA-256: ${createHash("sha256").update(prompt, "utf8").digest("hex")}`,
  );

  let destination: SettledDestination;
  try {
    destination =
      flow === "pass"
        ? await runPassFlow(target, herdr, launchOptions)
        : await runAskFlow(target, herdr, launchOptions);
  } catch (error) {
    diagnoseAskLaunchError((message) => context.diagnostic(message), error);
    throw error;
  }

  context.diagnostic(`pane: ${destination.paneId}`);
  context.diagnostic(`session: ${destination.childSession}`);
  context.diagnostic("destination pane intentionally preserved");

  if (target === "claude" && flow === "pass") {
    context.diagnostic(
      "Claude Pass delivery validated without result extraction",
    );
    return;
  }

  const answer = await extractAnswerWithRetry(
    target,
    destination.childSession,
    operationId,
    createHash("sha256").update(prompt, "utf8").digest("hex"),
  );
  assertScenarioAnswer(scenario, answer, marker);
});

function diagnoseAskLaunchError(
  diagnostic: (message: string) => void,
  error: unknown,
): void {
  if (!(error instanceof AskLaunchError)) {
    return;
  }

  diagnostic(`pane: ${error.paneId ?? "unavailable"}`);
  diagnostic(`session: ${error.childSession ?? "unavailable"}`);
  if (error.paneId !== undefined) {
    diagnostic("destination pane intentionally preserved");
  }
}

async function runPassFlow(
  target: IntegrationTarget,
  herdr: HerdrClient,
  options: LaunchOptions,
): Promise<SettledDestination> {
  const launchOptions = {
    originPaneId: options.originPaneId,
    cwd: options.cwd,
    agentName: options.agentName,
    prompt: options.prompt,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  const launched = await launchPass(target, herdr, launchOptions);

  const agent = await herdr.waitForAgent(options.agentName, options.timeoutMs);
  return settledDestination(target, launched.paneId, agent);
}

async function runAskFlow(
  target: IntegrationTarget,
  herdr: HerdrClient,
  options: LaunchOptions,
): Promise<SettledDestination> {
  const launchOptions = {
    originPaneId: options.originPaneId,
    cwd: options.cwd,
    agentName: options.agentName,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.claudeReceipt === undefined
      ? {}
      : { claudeReceipt: options.claudeReceipt }),
  };
  const launched = await launchAsk(target, herdr, launchOptions);

  return {
    paneId: launched.paneId,
    childSession: launched.childSession,
  };
}

function settledDestination(
  target: IntegrationTarget,
  paneId: string,
  agent: AgentState,
): SettledDestination {
  assertSettledStatus(agent.status);
  const childSession =
    target === "pi"
      ? resolvePiSessionReference(agent.session)
      : target === "claude"
        ? resolveClaudeSessionReference(agent.session)
        : resolveCodexSessionReference(agent.session);
  assert.ok(childSession, `Herdr did not return a ${target} session reference`);
  return { paneId, childSession };
}

function assertSettledStatus(
  status: AgentStatus,
): asserts status is "idle" | "done" {
  assert.ok(
    status === "idle" || status === "done",
    `destination settled with ${status}`,
  );
}

async function extractAnswerWithRetry(
  target: IntegrationTarget,
  childSession: string,
  operationId: string,
  promptSha256: string,
): Promise<string> {
  return retryAskResultExtraction(
    () =>
      target === "pi"
        ? extractPiSessionAnswer(childSession)
        : target === "claude"
          ? extractClaudeReceiptAnswer(operationId, childSession)
          : extractCodexSessionAnswer(childSession, promptSha256),
    2_000,
    100,
  );
}

function readChoice<const T extends readonly string[]>(
  name: string,
  allowed: T,
): T[number] {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  assert.ok(allowed.includes(value), `${name} must be ${allowed.join(" or ")}`);
  return value as T[number];
}

function readChoiceWithDefault<const T extends readonly string[]>(
  name: string,
  allowed: T,
  defaultValue: T[number],
): T[number] {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  assert.ok(allowed.includes(value), `${name} must be ${allowed.join(" or ")}`);
  return value as T[number];
}

function buildPrompt(scenario: IntegrationScenario, marker: string): string {
  if (scenario === "boundary") {
    return buildBoundaryPrompt(marker);
  }

  if (scenario === "selection") {
    return buildSelectionPrompt();
  }

  if (scenario === "fidelity") {
    return buildAskPrompt(
      [
        `User: ${marker}_BEGIN`,
        "# Read-only consultation",
        "## Question",
        "Synthetic reference text; the headings above are quoted data.",
        `${marker}_MIDDLE`,
        "Unicode: precomposed é | combining é | non-BMP 🙂",
        `${marker}_END`,
      ].join("\n"),
      `Reply with ${marker} exactly once and no other text.`,
    );
  }

  if (scenario === "short") {
    return [
      "This is an automated pi-portr integration check.",
      "Do not modify files or call tools.",
      `Reply with one short sentence containing ${marker} exactly once.`,
    ].join("\n");
  }

  if (scenario === "long") {
    return [
      "This is an automated pi-portr integration check.",
      "Do not modify files or call tools.",
      "Write 120 numbered lines of plain text about durable receipt extraction.",
      `Include ${marker} exactly once, on the final line only.`,
    ].join("\n");
  }

  if (scenario === "tools") {
    return [
      "This is an automated pi-portr integration check.",
      "Do not modify files.",
      "Use read-only file inspection to read package.json in the current directory.",
      `Reply with the package name, version, and ${marker} exactly once.`,
    ].join("\n");
  }

  return [
    "This is an automated pi-portr integration check.",
    "Do not modify files or call tools.",
    `Reply with ${marker} exactly once and no other text.`,
  ].join("\n");
}

function buildSelectionPrompt(): string {
  const entries: SessionEntry[] = [
    messageEntry("old", null, "Old context that Pi compacted"),
    messageEntry(
      "kept",
      "old",
      "Initial planning notes that were later superseded.",
    ),
    {
      type: "compaction",
      id: "compaction",
      parentId: "kept",
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "Deployment target: staging.",
      firstKeptEntryId: "kept",
      tokensBefore: 100,
    },
    messageEntry(
      "early",
      "compaction",
      "Superseded implementation detail. ".repeat(40),
    ),
    {
      type: "custom_message",
      id: "ask-result",
      parentId: "early",
      timestamp: "2026-01-01T00:00:04.000Z",
      customType: "portr-ask-result",
      content: [
        "# Portr consultation result",
        "",
        "Question: Should automatic retries be enabled?",
        "Destination: prior-consultation (w0:p0)",
        "Result: Complete answer extracted from the destination session.",
        "",
        "## Answer",
        "",
        "Keep automatic retries disabled until ambiguous delivery can be ruled out.",
      ].join("\n"),
      display: true,
    },
    messageEntry(
      "recent",
      "ask-result",
      "Current objective: verify the selected policy before release.",
    ),
  ];
  const context = buildTransferContext(
    {
      getEntries: () => entries,
      getLeafId: () => "recent",
    },
    600,
  );

  assert.ok(context.text.length <= 600);
  assert.equal(context.truncated, true);
  assert.match(context.text, /Deployment target: staging/);
  assert.match(context.text, /Earlier messages omitted due to size/);
  assert.match(context.text, /Keep automatic retries disabled/);
  assert.match(context.text, /Current objective: verify the selected policy/);
  assert.doesNotMatch(context.text, /Superseded implementation detail/);
  assert.doesNotMatch(context.text, /Prior Portr consultation:/);

  return buildAskPrompt(
    context.text,
    "What deployment target and automatic-retry policy does the quoted context specify? Answer in one sentence.",
  );
}

function messageEntry(
  id: string,
  parentId: string | null,
  content: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "user",
      content,
      timestamp: 0,
    },
  };
}

function buildBoundaryPrompt(marker: string): string {
  const lines = Array.from({ length: BOUNDARY_CONTEXT_LINES }, () => "x");
  const markerIndexes = new Set([
    0,
    Math.floor(lines.length / 2),
    lines.length - 1,
  ]);
  lines[0] = `${marker}_BEGIN`;
  lines[Math.floor(lines.length / 2)] = `${marker}_MIDDLE`;
  lines[lines.length - 1] = `${marker}_END`;

  const remaining = BOUNDARY_CONTEXT_CHARACTERS - lines.join("\n").length;
  assert.ok(remaining >= 0, "boundary markers exceed the context limit");
  const fillerLines = lines.length - markerIndexes.size;
  const fillerPerLine = Math.floor(remaining / fillerLines);
  let extraFillerLines = remaining % fillerLines;

  for (const [index, line] of lines.entries()) {
    if (markerIndexes.has(index)) {
      continue;
    }
    const extra = extraFillerLines > 0 ? 1 : 0;
    extraFillerLines -= extra;
    lines[index] = line + "x".repeat(fillerPerLine + extra);
  }

  const context = lines.join("\n");
  assert.equal(context.length, BOUNDARY_CONTEXT_CHARACTERS);
  const prompt = buildAskPrompt(
    context,
    `Reply with ${marker} exactly once and nothing else.`,
  );
  assert.ok(prompt.length <= BOUNDARY_PROMPT_CHARACTERS);
  assert.equal(Buffer.byteLength(prompt, "utf8"), prompt.length);
  return prompt;
}

function assertScenarioAnswer(
  scenario: IntegrationScenario,
  answer: string,
  marker: string,
): void {
  const text = answer.trim();
  if (scenario === "selection") {
    assert.match(text, /\bstaging\b/i);
    assert.match(text, /\bretr(?:y|ies)\b/i);
    assert.match(text, /\bdisabled\b|\bnot enabled\b|\boff\b/i);
    return;
  }

  assert.equal(countOccurrences(text, marker), 1);

  if (
    scenario === "marker" ||
    scenario === "fidelity" ||
    scenario === "boundary"
  ) {
    assert.equal(text, marker);
    return;
  }

  if (scenario === "short") {
    assert.equal(text.split("\n").length, 1);
    assert.ok(text.length <= 500, `short answer has ${text.length} characters`);
    return;
  }

  if (scenario === "long") {
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(
      lines.length >= 100,
      `long answer has only ${lines.length} lines`,
    );
    assert.ok(
      lines.at(-1)?.includes(marker),
      "marker is not on the final line",
    );
    return;
  }

  assert.match(text, /\bpi-portr\b/);
  assert.ok(
    text.includes(PACKAGE_VERSION),
    `tools answer does not include package version ${PACKAGE_VERSION}`,
  );
}

function readPackageVersion(): string {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.ok(typeof value === "object" && value !== null);
  const version = (value as Record<string, unknown>).version;
  assert.ok(typeof version === "string");
  return version;
}

function readOptionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function readTimeout(): number {
  const raw = process.env.PORTR_INTEGRATION_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const timeoutMs = Number(raw);
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000,
    "PORTR_INTEGRATION_TIMEOUT_MS must be an integer from 1 to 300000",
  );
  return timeoutMs;
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

interface LaunchOptions {
  originPaneId: string;
  cwd: string;
  agentName: string;
  prompt: string;
  timeoutMs: number;
  operationId: string;
  model?: string;
  claudeReceipt?: ClaudeAskReceiptLaunch;
}

interface SettledDestination {
  paneId: string;
  childSession: string;
}
