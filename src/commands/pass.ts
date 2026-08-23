import { randomUUID } from "node:crypto";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildClaudeLaunchArgs,
  resolveClaudeSessionReference,
} from "../claude-target.ts";
import {
  boundText,
  buildTransferContext,
  quoteReferenceBlock,
  sanitizeTransferText,
} from "../context.ts";
import {
  type AgentState,
  createDestinationPane,
  type CreateOrchestrator,
  type Orchestrator,
} from "../orchestrator.ts";
import { buildPiLaunchArgs, resolvePiSessionReference } from "../pi-target.ts";
import {
  DEFAULT_MAX_PANES,
  type LoadPortrSettings,
  readPortrSettings,
} from "../settings.ts";
import {
  PASS_RECEIPT_ENTRY,
  PASS_RECEIPT_STATE_VERSION,
  type PassFocusStatus,
  type PassReceipt,
} from "../state.ts";

const MAX_HANDOFF_CHARACTERS = 60_000;
const MAX_PASS_FAILURE_CHARACTERS = 1_000;

const HANDOFF_SYSTEM_PROMPT = `You create self-contained handoff prompts for coding agents.

Given a quoted conversation context and a requested continuation:
- preserve the current objective, settled decisions, constraints, relevant files, completed work, and unresolved questions;
- state the next task clearly;
- do not continue or answer the quoted conversation;
- do not invent facts;
- do not include hidden reasoning or a preamble;
- be concise, but include enough context for an independent session to continue.

Use clear Markdown headings.`;

export type PassTarget = "pi" | "claude";

export interface PassArguments {
  target: PassTarget;
  goal: string;
  model?: string;
}

export type PassLaunchStage = "split" | "start" | "prompt" | "focus";

export interface PassLaunchResult {
  agentName: string;
  paneId: string;
  focusStatus: Exclude<PassFocusStatus, "not_attempted" | "failed">;
}

export class PassUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassUsageError";
  }
}

export class PassLaunchError extends Error {
  readonly stage: PassLaunchStage;
  readonly agentName: string;
  readonly paneId: string | undefined;
  readonly agent: AgentState | undefined;

  constructor(
    stage: PassLaunchStage,
    agentName: string,
    paneId: string | undefined,
    cause: unknown,
    agent?: AgentState,
  ) {
    const references = [
      paneId === undefined ? undefined : `pane ${paneId}`,
      stage === "split" ? undefined : `agent name ${agentName}`,
    ]
      .filter((value) => value !== undefined)
      .join(", ");
    const referenceText =
      references.length === 0 ? "" : `; destination references: ${references}`;
    super(
      `Pass failed during ${stage}${referenceText}: ${errorMessage(cause)}`,
      {
        cause,
      },
    );
    this.name = "PassLaunchError";
    this.stage = stage;
    this.agentName = agentName;
    this.paneId = agent?.paneId ?? paneId;
    this.agent = agent;
  }
}

export function registerPassCommand(
  pi: ExtensionAPI,
  createOrchestrator: CreateOrchestrator,
  loadSettings: LoadPortrSettings = readPortrSettings,
): void {
  pi.registerCommand("portr-pass", {
    description: "Hand off work to another visible agent session",
    handler: async (args, ctx) => {
      await handlePass(pi, createOrchestrator, loadSettings, args, ctx);
    },
  });
}

export function parsePassArguments(input: string): PassArguments {
  const [targetToken, afterTarget] = takeToken(input.trim());
  if (targetToken !== "pi" && targetToken !== "claude") {
    throw new PassUsageError(
      "Usage: /portr-pass <pi|claude> [--model <model>] <goal>",
    );
  }

  let remainder = afterTarget.trimStart();
  let model: string | undefined;

  while (remainder.startsWith("--")) {
    if (remainder === "--") {
      remainder = "";
      break;
    }
    if (remainder.startsWith("-- ")) {
      remainder = remainder.slice(3);
      break;
    }

    const [option, afterOption] = takeToken(remainder);
    if (option !== "--model") {
      throw new PassUsageError(`Unknown option: ${option}`);
    }
    if (model !== undefined) {
      throw new PassUsageError("--model may only be provided once");
    }

    const [modelToken, afterModel] = takeToken(afterOption.trimStart());
    if (modelToken.length === 0) {
      throw new PassUsageError("--model requires a value");
    }

    model = modelToken;
    remainder = afterModel.trimStart();
  }

  const goal = remainder.trim();
  if (goal.length === 0) {
    throw new PassUsageError("A handoff goal is required");
  }

  return model === undefined
    ? { target: targetToken, goal }
    : { target: targetToken, goal, model };
}

export async function launchPass(
  target: PassTarget,
  orchestrator: Orchestrator,
  options: {
    originPaneId: string;
    cwd: string;
    agentName: string;
    prompt: string;
    model?: string;
    maxPanes?: number;
    onPaneCreated?(paneId: string): void;
    onDelivered?(agent: AgentState): void;
  },
): Promise<PassLaunchResult> {
  let stage: PassLaunchStage = "split";
  let paneId: string | undefined;

  try {
    paneId = await createDestinationPane(orchestrator, {
      originPaneId: options.originPaneId,
      cwd: options.cwd,
      maxPanes: options.maxPanes ?? DEFAULT_MAX_PANES,
    });
    options.onPaneCreated?.(paneId);

    stage = "start";
    await orchestrator.startAgent(
      target,
      options.agentName,
      paneId,
      target === "pi"
        ? buildPiLaunchArgs({
            readOnly: false,
            ...(options.model === undefined ? {} : { model: options.model }),
          })
        : buildClaudeLaunchArgs({
            readOnly: false,
            ...(options.model === undefined ? {} : { model: options.model }),
          }),
    );

    stage = "prompt";
    const agent = await promptPassDestination(
      orchestrator,
      options.agentName,
      options.prompt,
    );
    if (agent.status === "blocked") {
      throw new PassLaunchError(
        stage,
        options.agentName,
        paneId,
        new Error("destination is blocked and requires intervention"),
        agent,
      );
    }
    if (agent.status !== "working") {
      throw new PassLaunchError(
        stage,
        options.agentName,
        paneId,
        new Error(
          `destination did not acknowledge the prompt (status ${agent.status})`,
        ),
        agent,
      );
    }
    options.onDelivered?.(agent);

    stage = "focus";
    const focusStatus = await focusDestinationIfOriginRemainsFocused(
      orchestrator,
      options.originPaneId,
      options.agentName,
    );

    return { agentName: options.agentName, paneId, focusStatus };
  } catch (error) {
    if (error instanceof PassLaunchError) {
      throw error;
    }
    throw new PassLaunchError(stage, options.agentName, paneId, error);
  }
}

async function focusDestinationIfOriginRemainsFocused(
  orchestrator: Orchestrator,
  originPaneId: string,
  agentName: string,
): Promise<"focused" | "skipped"> {
  let originIsFocused: boolean;
  try {
    originIsFocused = await orchestrator.paneIsFocused(originPaneId);
  } catch {
    return "skipped";
  }

  if (!originIsFocused) {
    return "skipped";
  }
  await orchestrator.focus(agentName);
  return "focused";
}

async function promptPassDestination(
  orchestrator: Orchestrator,
  agentName: string,
  prompt: string,
): Promise<AgentState> {
  return orchestrator.promptUntilWorking(agentName, prompt);
}

async function handlePass(
  pi: ExtensionAPI,
  createOrchestrator: CreateOrchestrator,
  loadSettings: LoadPortrSettings,
  rawArguments: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/portr-pass requires interactive mode", "error");
    return;
  }

  let args: PassArguments;
  try {
    args = parsePassArguments(rawArguments);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return;
  }

  const originSession = ctx.sessionManager.getSessionFile();
  if (originSession === undefined) {
    ctx.ui.notify("Pass requires a persisted origin session", "error");
    return;
  }
  if (ctx.model === undefined) {
    ctx.ui.notify("No model selected for handoff generation", "error");
    return;
  }

  const orchestrator = createOrchestrator();
  let originPaneId: string;
  try {
    originPaneId = await orchestrator.currentPane();
  } catch (error) {
    ctx.ui.notify(
      `Orchestration preflight failed: ${errorMessage(error)}`,
      "error",
    );
    return;
  }

  const context = buildTransferContext(ctx.sessionManager);
  if (context.text.length === 0) {
    ctx.ui.notify("No conversation context to hand off", "error");
    return;
  }

  const truncationNote = context.truncated ? " (earlier context omitted)" : "";
  ctx.ui.notify(
    `Generating handoff from ${context.text.length} characters${truncationNote}`,
    "info",
  );

  const goal = sanitizeTransferText(args.goal);
  const generated = await generateHandoff(ctx, context.text, goal);
  if (generated.status === "cancelled") {
    ctx.ui.notify("Pass cancelled", "info");
    return;
  }
  if (generated.status === "error") {
    ctx.ui.notify(`Handoff generation failed: ${generated.message}`, "error");
    return;
  }

  const approvedPrompt = await ctx.ui.editor(
    "Review handoff prompt — save to continue",
    generated.text,
  );
  if (approvedPrompt === undefined) {
    ctx.ui.notify("Pass cancelled", "info");
    return;
  }
  if (approvedPrompt.trim().length === 0) {
    ctx.ui.notify("Handoff prompt cannot be empty", "error");
    return;
  }
  if (approvedPrompt.length > MAX_HANDOFF_CHARACTERS) {
    ctx.ui.notify(
      `Handoff prompt exceeds the ${MAX_HANDOFF_CHARACTERS}-character limit`,
      "error",
    );
    return;
  }
  if (sanitizeTransferText(approvedPrompt) !== approvedPrompt) {
    ctx.ui.notify("Handoff prompt must not contain base64 payloads", "error");
    return;
  }

  const operationId = randomUUID();
  const agentName = `portr-pass-${operationId.slice(0, 8)}`;
  const now = Date.now();
  let receipt: PassReceipt = {
    version: PASS_RECEIPT_STATE_VERSION,
    kind: "pass",
    operationId,
    originSession,
    target: args.target,
    ...(args.model === undefined ? {} : { model: args.model }),
    goal,
    approvedPrompt,
    deliveryStatus: "approved",
    focusStatus: "not_attempted",
    launchStage: "approved",
    agentName,
    createdAt: now,
    updatedAt: now,
  };
  const persist = (next: PassReceipt): void => {
    receipt = next;
    pi.appendEntry(PASS_RECEIPT_ENTRY, receipt);
  };
  persist(receipt);

  try {
    let maxPanes: number;
    try {
      ({ maxPanes } = await loadSettings());
    } catch (error) {
      throw new Error(`Portr settings unavailable: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    const launchOptions = {
      originPaneId,
      cwd: ctx.cwd,
      agentName,
      prompt: approvedPrompt,
      maxPanes,
      ...(args.model === undefined ? {} : { model: args.model }),
      onPaneCreated: (paneId: string) => {
        persist({
          ...receipt,
          paneId,
          launchStage: "split",
          updatedAt: Date.now(),
        });
      },
      onDelivered: (agent: AgentState) => {
        const childSession = resolvePassSessionReference(
          args.target,
          agent.session,
        );
        persist({
          ...receipt,
          paneId: agent.paneId,
          ...(childSession === undefined ? {} : { childSession }),
          deliveryStatus: "delivered",
          launchStage: "prompt",
          updatedAt: Date.now(),
        });
      },
    };
    const result = await launchPass(args.target, orchestrator, launchOptions);
    persist({
      ...receipt,
      paneId: result.paneId,
      deliveryStatus: "delivered",
      focusStatus: result.focusStatus,
      launchStage: "focus",
      updatedAt: Date.now(),
    });
    ctx.ui.notify(
      `Handoff delivered to ${result.agentName} (${result.paneId})`,
      "info",
    );
  } catch (error) {
    const launchError = error instanceof PassLaunchError ? error : undefined;
    const stage = launchError?.stage ?? "split";
    const childSession = resolvePassSessionReference(
      args.target,
      launchError?.agent?.session,
    );
    const delivered = receipt.deliveryStatus === "delivered";
    persist({
      ...receipt,
      ...(launchError?.paneId === undefined
        ? {}
        : { paneId: launchError.paneId }),
      ...(childSession === undefined ? {} : { childSession }),
      deliveryStatus: delivered ? "delivered" : "failed",
      focusStatus: delivered && stage === "focus" ? "failed" : "not_attempted",
      launchStage: stage,
      failure: { message: boundedFailureMessage(error) },
      updatedAt: Date.now(),
    });
    ctx.ui.notify(errorMessage(error), "error");
  }
}

type GenerationResult =
  | { status: "ok"; text: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

async function generateHandoff(
  ctx: ExtensionCommandContext,
  conversation: string,
  goal: string,
): Promise<GenerationResult> {
  const model = ctx.model;
  if (model === undefined) {
    return { status: "error", message: "No model selected" };
  }

  return ctx.ui.custom<GenerationResult>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Generating handoff...");
    loader.onAbort = () => done({ status: "cancelled" });

    const generate = async (): Promise<GenerationResult> => {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: HANDOFF_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "## Quoted origin context",
                    "",
                    quoteReferenceBlock(conversation),
                    "",
                    "## Requested continuation",
                    "",
                    goal,
                  ].join("\n"),
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal: loader.signal,
          cacheRetention: "none",
          sessionId: randomUUID(),
        },
      );

      if (response.stopReason === "aborted") {
        return { status: "cancelled" };
      }
      if (response.stopReason !== "stop") {
        return {
          status: "error",
          message: `Model stopped with ${response.stopReason}`,
        };
      }

      const text = response.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n")
        .trim();

      return text.length === 0
        ? { status: "error", message: "Model returned no text" }
        : { status: "ok", text };
    };

    generate()
      .then(done)
      .catch((error: unknown) => {
        done({ status: "error", message: errorMessage(error) });
      });

    return loader;
  });
}

function resolvePassSessionReference(
  target: PassTarget,
  session: AgentState["session"],
): string | undefined {
  return target === "pi"
    ? resolvePiSessionReference(session)
    : resolveClaudeSessionReference(session);
}

function boundedFailureMessage(error: unknown): string {
  return boundText(
    sanitizeTransferText(errorMessage(error)),
    MAX_PASS_FAILURE_CHARACTERS,
  ).text;
}

function takeToken(input: string): [string, string] {
  const match = /^(\S+)([\s\S]*)$/.exec(input);
  return match === null ? ["", ""] : [match[1] ?? "", match[2] ?? ""];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
