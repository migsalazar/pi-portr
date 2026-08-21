import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { retryAskResultExtraction } from "../../src/async-ask.ts";
import {
  extractClaudeSessionAnswer,
  resolveClaudeSessionReference,
} from "../../src/claude-target.ts";
import { launchAsk } from "../../src/commands/ask.ts";
import { launchPass } from "../../src/commands/pass.ts";
import {
  type HerdrAgent,
  type HerdrAgentStatus,
  HerdrClient,
} from "../../src/herdr.ts";
import {
  extractPiSessionAnswer,
  resolvePiSessionReference,
} from "../../src/pi-target.ts";

type IntegrationTarget = "pi" | "claude";

const RUN_MODEL_INTEGRATION = process.env.PORTR_RUN_MODEL_INTEGRATION === "1";
const DEFAULT_TIMEOUT_MS = 180_000;

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
  ] as const);
  const flow = readChoice("PORTR_INTEGRATION_FLOW", ["pass", "ask"] as const);
  const timeoutMs = readTimeout();
  const model = readOptionalEnvironment("PORTR_INTEGRATION_MODEL");
  const scenario = readChoiceWithDefault(
    "PORTR_INTEGRATION_SCENARIO",
    ["marker", "short", "long", "tools"] as const,
    "marker",
  );
  const operationId = randomUUID();
  const marker = `PORTR_INTEGRATION_${operationId.replaceAll("-", "_")}`;
  const agentName = `portr-integration-${operationId.slice(0, 8)}`;
  const prompt = buildPrompt(scenario, marker);
  const cwd = process.cwd();
  const herdr = new HerdrClient();
  const originPaneId = await herdr.currentPane();

  const launchOptions = {
    originPaneId,
    cwd,
    agentName,
    prompt,
    timeoutMs,
    ...(model === undefined ? {} : { model }),
  };
  const destination =
    flow === "pass"
      ? await runPassFlow(target, herdr, launchOptions)
      : await runAskFlow(target, herdr, launchOptions);

  const answer = await extractAnswerWithRetry(
    target,
    destination.childSession,
    cwd,
  );
  assert.equal(countOccurrences(answer, marker), 1);

  context.diagnostic(`target: ${target}`);
  context.diagnostic(`flow: ${flow}`);
  context.diagnostic(`scenario: ${scenario}`);
  context.diagnostic(`agent: ${agentName}`);
  context.diagnostic(`pane: ${destination.paneId}`);
  context.diagnostic(`session: ${destination.childSession}`);
  context.diagnostic("destination pane intentionally preserved");
});

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
  agent: HerdrAgent,
): SettledDestination {
  assertSettledStatus(agent.status);
  const childSession =
    target === "pi"
      ? resolvePiSessionReference(agent.session)
      : resolveClaudeSessionReference(agent.session);
  assert.ok(childSession, `Herdr did not return a ${target} session reference`);
  return { paneId, childSession };
}

function assertSettledStatus(
  status: HerdrAgentStatus,
): asserts status is "idle" | "done" {
  assert.ok(
    status === "idle" || status === "done",
    `destination settled with ${status}`,
  );
}

async function extractAnswerWithRetry(
  target: IntegrationTarget,
  childSession: string,
  cwd: string,
): Promise<string> {
  return retryAskResultExtraction(
    () =>
      target === "pi"
        ? extractPiSessionAnswer(childSession)
        : extractClaudeSessionAnswer(childSession, cwd),
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

function buildPrompt(
  scenario: "marker" | "short" | "long" | "tools",
  marker: string,
): string {
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
      "Write 120 numbered lines of plain text about durable transcript extraction.",
      `Include ${marker} exactly once, on the final line only.`,
    ].join("\n");
  }

  if (scenario === "tools") {
    return [
      "This is an automated pi-portr integration check.",
      "Do not modify files.",
      "Use read-only file inspection to read package.json in the current directory.",
      `Reply with the package name and ${marker} exactly once.`,
    ].join("\n");
  }

  return [
    "This is an automated pi-portr integration check.",
    "Do not modify files or call tools.",
    `Reply with ${marker} exactly once and no other text.`,
  ].join("\n");
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
  model?: string;
}

interface SettledDestination {
  paneId: string;
  childSession: string;
}
