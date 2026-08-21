import { randomUUID } from "node:crypto";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildClaudeLaunchArgs } from "../claude-target.ts";
import { buildTransferContext } from "../context.ts";
import { HerdrClient } from "../herdr.ts";
import { buildPiLaunchArgs } from "../pi-target.ts";

const MAX_HANDOFF_CHARACTERS = 60_000;

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

  constructor(
    stage: PassLaunchStage,
    agentName: string,
    paneId: string | undefined,
    cause: unknown,
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
    this.paneId = paneId;
  }
}

export function registerPassCommand(pi: ExtensionAPI): void {
  pi.registerCommand("portr-pass", {
    description: "Hand off work to another visible agent session",
    handler: async (args, ctx) => {
      await handlePass(args, ctx);
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
  herdr: HerdrClient,
  options: {
    originPaneId: string;
    cwd: string;
    agentName: string;
    prompt: string;
    model?: string;
  },
): Promise<PassLaunchResult> {
  let stage: PassLaunchStage = "split";
  let paneId: string | undefined;

  try {
    paneId = await herdr.splitPane({
      paneId: options.originPaneId,
      cwd: options.cwd,
      direction: "right",
    });

    stage = "start";
    await herdr.startAgent(
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
    await promptPassDestination(herdr, options.agentName, options.prompt);

    stage = "focus";
    await focusDestinationIfOriginRemainsFocused(
      herdr,
      options.originPaneId,
      options.agentName,
    );

    return { agentName: options.agentName, paneId };
  } catch (error) {
    throw new PassLaunchError(stage, options.agentName, paneId, error);
  }
}

async function focusDestinationIfOriginRemainsFocused(
  herdr: HerdrClient,
  originPaneId: string,
  agentName: string,
): Promise<void> {
  let originIsFocused: boolean;
  try {
    originIsFocused = await herdr.paneIsFocused(originPaneId);
  } catch {
    return;
  }

  if (originIsFocused) {
    await herdr.focus(agentName);
  }
}

async function promptPassDestination(
  herdr: HerdrClient,
  agentName: string,
  prompt: string,
): Promise<void> {
  const agent = await herdr.promptUntilWorking(agentName, prompt);
  if (agent.status === "blocked") {
    throw new Error("destination is blocked and requires intervention");
  }
  if (agent.status !== "working") {
    throw new Error(
      `destination did not acknowledge the prompt (status ${agent.status})`,
    );
  }
}

async function handlePass(
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

  if (ctx.model === undefined) {
    ctx.ui.notify("No model selected for handoff generation", "error");
    return;
  }

  const herdr = new HerdrClient();
  let originPaneId: string;
  try {
    originPaneId = await herdr.currentPane();
  } catch (error) {
    ctx.ui.notify(`Herdr preflight failed: ${errorMessage(error)}`, "error");
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

  const generated = await generateHandoff(ctx, context.text, args.goal);
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

  const agentName = `portr-pass-${randomUUID().slice(0, 8)}`;
  try {
    const launchOptions = {
      originPaneId,
      cwd: ctx.cwd,
      agentName,
      prompt: approvedPrompt,
      ...(args.model === undefined ? {} : { model: args.model }),
    };
    const result = await launchPass(args.target, herdr, launchOptions);
    ctx.ui.notify(
      `Handoff delivered to ${result.agentName} (${result.paneId})`,
      "info",
    );
  } catch (error) {
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
                    conversation,
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

function takeToken(input: string): [string, string] {
  const match = /^(\S+)([\s\S]*)$/.exec(input);
  return match === null ? ["", ""] : [match[1] ?? "", match[2] ?? ""];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
