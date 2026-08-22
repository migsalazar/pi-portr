import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { AskResultError } from "./ask-result.ts";
import {
  extractClaudeSessionAnswer,
  resolveClaudeSessionReference,
} from "./claude-target.ts";
import { boundText, sanitizeTransferText } from "./context.ts";
import {
  type AgentSessionReference,
  type AgentState,
  type AgentStatus,
  type Orchestrator,
  OrchestrationError,
} from "./orchestrator.ts";
import {
  extractPiSessionAnswer,
  resolvePiSessionReference,
} from "./pi-target.ts";
import {
  ASYNC_ASK_OPERATION_ENTRY,
  ASYNC_ASK_RESULT_MESSAGE,
  type AskOperationFailure,
  type AsyncAskOperation,
  type FailureReason,
  restoreAsyncAskOperations,
  type StoredAskResult,
} from "./state.ts";

export const ASK_WAIT_TIMEOUT_MS = 300_000;
const ASK_RECOVERY_ACTIVITY_WAIT_MS = 5_000;
export const ASK_RESULT_RETRY_TIMEOUT_MS = 2_000;
export const ASK_RESULT_RETRY_INTERVAL_MS = 100;
export const MAX_RETURN_ANSWER_CHARACTERS = 40_000;
const QUESTION_EXCERPT_CHARACTERS = 1_000;

export type AskTarget = "pi" | "claude";
export type AskLaunchStage = "split" | "start" | "prompt_wait";

export interface AskDestination {
  agentName: string;
  paneId: string;
}

export interface AskLaunchResult {
  target: AskTarget;
  agentName: string;
  paneId: string;
  childSession: string;
}

export interface AskDeliveryPort {
  send(
    result: StoredAskResult,
    options: { deliverAs: "followUp"; triggerTurn: true },
  ): void;
  persist(operation: AsyncAskOperation): void;
}

export type AskDeliveryOutcome = "sent" | "already_present" | "ignored";

export function hasAskResultMessage(
  entries: readonly SessionEntry[],
  operationId: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === ASYNC_ASK_RESULT_MESSAGE &&
      isRecord(entry.details) &&
      entry.details.operationId === operationId,
  );
}

export function deliverTerminalAskOperation(
  operation: AsyncAskOperation,
  entries: readonly SessionEntry[],
  port: AskDeliveryPort,
  now = Date.now(),
): AskDeliveryOutcome {
  if (operation.status !== "completed" && operation.status !== "failed") {
    return "ignored";
  }

  const alreadyPresent = hasAskResultMessage(entries, operation.operationId);
  if (!alreadyPresent) {
    if (operation.result === undefined) {
      throw new Error(
        `Terminal ask operation ${operation.operationId} has no stored result`,
      );
    }
    port.send(operation.result, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
    return "sent";
  }

  port.persist({
    ...operation,
    status: "delivered",
    outcome: operation.status,
    updatedAt: now,
  });
  return "already_present";
}

export class AskLaunchError extends Error {
  readonly stage: AskLaunchStage;
  readonly agentName: string;
  readonly paneId: string | undefined;
  readonly status: AgentStatus | undefined;
  readonly childSession: string | undefined;

  constructor(
    stage: AskLaunchStage,
    agentName: string,
    paneId: string | undefined,
    cause: unknown,
    agent?: AgentState,
  ) {
    const resolvedPaneId = agent?.paneId ?? paneId;
    const childSession = agent?.session?.value;
    const references = [
      resolvedPaneId === undefined ? undefined : `pane ${resolvedPaneId}`,
      stage === "split" ? undefined : `agent name ${agentName}`,
      childSession === undefined ? undefined : `child session ${childSession}`,
    ]
      .filter((value) => value !== undefined)
      .join(", ");
    const referenceText =
      references.length === 0 ? "" : `; destination references: ${references}`;
    super(
      `Ask failed during ${stage}${referenceText}: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = "AskLaunchError";
    this.stage = stage;
    this.agentName = agentName;
    this.paneId = resolvedPaneId;
    this.status = agent?.status;
    this.childSession = childSession;
  }
}

export function resolveSettledAskAgent(
  target: AskTarget,
  destination: AskDestination,
  agent: AgentState,
): AskLaunchResult {
  if (agent.status === "blocked") {
    throw new AskLaunchError(
      "prompt_wait",
      destination.agentName,
      destination.paneId,
      new Error("destination is blocked and requires intervention"),
      agent,
    );
  }
  if (agent.status !== "idle" && agent.status !== "done") {
    throw new AskLaunchError(
      "prompt_wait",
      destination.agentName,
      destination.paneId,
      new Error(`destination settled with ambiguous status ${agent.status}`),
      agent,
    );
  }
  const childSession = resolveAskSessionReference(target, agent.session);
  if (childSession === undefined) {
    throw new AskLaunchError(
      "prompt_wait",
      destination.agentName,
      destination.paneId,
      new Error(`destination did not expose its ${target} session reference`),
      agent,
    );
  }

  return {
    target,
    agentName: destination.agentName,
    paneId: agent.paneId,
    childSession,
  };
}

export function buildAskResultMessage(options: {
  operationId: string;
  target: AskTarget;
  question: string;
  answer: string;
  agentName: string;
  paneId: string;
  childSession: string;
  originSession?: string;
}) {
  const boundedAnswer = boundText(
    sanitizeTransferText(options.answer),
    MAX_RETURN_ANSWER_CHARACTERS,
  );
  const boundedQuestion = boundText(
    sanitizeTransferText(options.question),
    QUESTION_EXCERPT_CHARACTERS,
  );
  const questionSuffix = boundedQuestion.truncated ? "…" : "";
  const resultNote = boundedAnswer.truncated
    ? `Bounded excerpt (${boundedAnswer.text.length} of ${boundedAnswer.originalLength} characters). The complete answer remains in the destination session.`
    : "Complete answer extracted from the destination session.";

  const content = [
    "# Portr consultation result",
    "",
    `Question: ${boundedQuestion.text}${questionSuffix}`,
    `Destination: ${options.agentName} (${options.paneId})`,
    `Result: ${resultNote}`,
    "",
    "## Answer",
    "",
    boundedAnswer.text,
  ].join("\n");

  const baseDetails = {
    operationId: options.operationId,
    target: options.target,
    agentName: options.agentName,
    paneId: options.paneId,
    childSession: options.childSession,
    status: "completed" as const,
    truncated: boundedAnswer.truncated,
    originalAnswerLength: boundedAnswer.originalLength,
  };

  return {
    content,
    details:
      options.originSession === undefined
        ? baseDetails
        : { ...baseDetails, originSession: options.originSession },
  };
}

export interface AsyncAskCoordinatorDependencies {
  createOrchestrator(): Orchestrator;
  extractAnswer?(target: AskTarget, childSession: string, cwd?: string): string;
  resultRetryTimeoutMs?: number;
  resultRetryIntervalMs?: number;
}

function defaultExtractAnswer(
  target: AskTarget,
  childSession: string,
  cwd?: string,
): string {
  if (target === "pi") {
    return extractPiSessionAnswer(childSession);
  }
  if (cwd === undefined) {
    throw new AskResultError("Claude ask operation did not preserve its cwd");
  }
  return extractClaudeSessionAnswer(childSession, cwd);
}

export class AsyncAskCoordinator {
  private generation = 0;
  private readonly active = new Set<string>();
  private readonly deliveryPending = new Set<string>();
  private originSession: string | undefined;
  private readonly pi: ExtensionAPI;
  private readonly dependencies: AsyncAskCoordinatorDependencies;

  constructor(pi: ExtensionAPI, dependencies: AsyncAskCoordinatorDependencies) {
    this.pi = pi;
    this.dependencies = dependencies;
  }

  reconcile(ctx: ExtensionContext): void {
    const originSession = ctx.sessionManager.getSessionFile();
    if (originSession === undefined) {
      if (this.originSession !== undefined) {
        this.generation += 1;
        this.active.clear();
        this.deliveryPending.clear();
        this.originSession = undefined;
      }
      return;
    }

    if (originSession !== this.originSession) {
      this.generation += 1;
      this.active.clear();
      this.deliveryPending.clear();
      this.originSession = originSession;
    }
    const generation = this.generation;

    const entries = ctx.sessionManager.getBranch();
    const operations = restoreAsyncAskOperations(entries);
    for (const operation of operations.values()) {
      if (operation.originSession !== originSession) {
        continue;
      }
      if (operation.status === "working") {
        this.monitor(operation, ctx, generation);
      } else if (
        operation.status === "completed" ||
        operation.status === "failed"
      ) {
        this.deliver(operation, ctx, generation);
      }
    }
  }

  stop(): void {
    this.generation += 1;
    this.active.clear();
    this.deliveryPending.clear();
    this.originSession = undefined;
  }

  acknowledgePersistedResults(ctx: ExtensionContext): void {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom_message" &&
        entry.customType === ASYNC_ASK_RESULT_MESSAGE &&
        isRecord(entry.details) &&
        typeof entry.details.operationId === "string"
      ) {
        this.acknowledgeResult(entry.details.operationId, ctx);
      }
    }
  }

  acknowledgeResult(operationId: string, ctx: ExtensionContext): void {
    const operation = restoreAsyncAskOperations(
      ctx.sessionManager.getBranch(),
    ).get(operationId);
    if (
      operation === undefined ||
      (operation.status !== "completed" && operation.status !== "failed")
    ) {
      return;
    }
    this.deliveryPending.delete(operationId);
    this.deliver(operation, ctx, this.generation);
  }

  monitorFresh(
    operation: AsyncAskOperation,
    prompt: string,
    ctx: ExtensionContext,
  ): void {
    const originSession = ctx.sessionManager.getSessionFile();
    if (originSession !== this.originSession) {
      this.generation += 1;
      this.active.clear();
      this.deliveryPending.clear();
      this.originSession = originSession;
    }
    this.monitor(operation, ctx, this.generation, prompt);
  }

  private monitor(
    operation: AsyncAskOperation,
    ctx: ExtensionContext,
    generation: number,
    prompt?: string,
  ): void {
    if (this.active.has(operation.operationId)) {
      return;
    }
    this.active.add(operation.operationId);

    void this.runMonitor(operation, ctx, generation, prompt).finally(() => {
      if (generation === this.generation) {
        this.active.delete(operation.operationId);
      }
    });
  }

  private async runMonitor(
    operation: AsyncAskOperation,
    ctx: ExtensionContext,
    generation: number,
    prompt?: string,
  ): Promise<void> {
    let terminal: AsyncAskOperation;
    let childSession: string | undefined;

    try {
      const timeoutMs = operation.deadlineAt - Date.now();
      if (prompt !== undefined && timeoutMs <= 0) {
        throw new OrchestrationError("consultation deadline elapsed", {
          code: "timeout",
        });
      }

      const orchestrator = this.dependencies.createOrchestrator();
      const recovered =
        prompt === undefined
          ? await this.recoverAsk(operation, orchestrator, (session) => {
              childSession = session;
            })
          : undefined;
      const launch =
        recovered?.launch ??
        resolveSettledAskAgent(
          operation.target,
          operation,
          await orchestrator.promptAndWait(
            operation.agentName,
            prompt ?? "",
            timeoutMs,
          ),
        );
      childSession = launch.childSession;
      const answer =
        recovered?.answer ??
        (await this.extractAnswer(operation, launch.childSession));
      const result = buildAskResultMessage({
        operationId: operation.operationId,
        target: operation.target,
        question: operation.question,
        answer,
        agentName: operation.agentName,
        paneId: launch.paneId,
        childSession: launch.childSession,
        originSession: operation.originSession,
      });
      terminal = {
        ...operation,
        status: "completed",
        paneId: launch.paneId,
        childSession: launch.childSession,
        result: { content: result.content, details: { ...result.details } },
        updatedAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof AskLaunchError && error.childSession !== undefined) {
        childSession = error.childSession;
      }
      const failure = classifyAsyncAskFailure(error);
      const failedOperation = {
        ...operation,
        status: "failed" as const,
        updatedAt: Date.now(),
        failure,
        ...(childSession === undefined ? {} : { childSession }),
      };
      terminal = {
        ...failedOperation,
        result: buildAsyncAskFailureResult(failedOperation, failure),
      };
    }

    if (!this.isCurrentWorkingOperation(operation, ctx, generation)) {
      return;
    }

    try {
      this.persist(terminal);
      this.deliver(terminal, ctx, generation);
    } catch (error) {
      if (this.isCurrent(operation, ctx, generation)) {
        ctx.ui.notify(
          `Could not persist or deliver async ask ${operation.operationId}: ${errorMessage(error)}`,
          "error",
        );
      }
    }
  }

  private async recoverAsk(
    operation: AsyncAskOperation,
    orchestrator: Orchestrator,
    preserveChildSession: (session: string) => void,
  ): Promise<{ launch: AskLaunchResult; answer: string }> {
    while (true) {
      const agent = await orchestrator.getAgent(operation.agentName);
      const childSession = resolveAskSessionReference(
        operation.target,
        agent.session,
      );
      if (childSession !== undefined) {
        preserveChildSession(childSession);
      }
      if (agent.status === "working") {
        const remaining = remainingAskTime(operation);
        const settled = await orchestrator.waitForAgent(
          operation.agentName,
          remaining,
        );
        const launch = resolveSettledAskAgent(
          operation.target,
          operation,
          settled,
        );
        return {
          launch,
          answer: await this.extractAnswer(operation, launch.childSession),
        };
      }

      const launch = resolveSettledAskAgent(operation.target, operation, agent);
      try {
        return {
          launch,
          answer: await this.extractAnswer(operation, launch.childSession),
        };
      } catch (error) {
        if (agent.status === "done" || !(error instanceof AskResultError)) {
          throw error;
        }
      }

      const activityWait = Math.min(
        ASK_RECOVERY_ACTIVITY_WAIT_MS,
        remainingAskTime(operation),
      );
      try {
        await orchestrator.waitForAgent(operation.agentName, activityWait, [
          "working",
          "done",
          "blocked",
        ]);
      } catch (error) {
        if (
          !(error instanceof OrchestrationError) ||
          error.code !== "timeout"
        ) {
          throw error;
        }
      }
    }
  }

  private async extractAnswer(
    operation: AsyncAskOperation,
    childSession: string,
  ): Promise<string> {
    return retryAskResultExtraction(
      () =>
        (this.dependencies.extractAnswer ?? defaultExtractAnswer)(
          operation.target,
          childSession,
          operation.cwd,
        ),
      this.dependencies.resultRetryTimeoutMs ?? ASK_RESULT_RETRY_TIMEOUT_MS,
      this.dependencies.resultRetryIntervalMs ?? ASK_RESULT_RETRY_INTERVAL_MS,
    );
  }

  private deliver(
    operation: AsyncAskOperation,
    ctx: ExtensionContext,
    generation: number,
  ): void {
    if (
      !this.isCurrent(operation, ctx, generation) ||
      this.deliveryPending.has(operation.operationId)
    ) {
      return;
    }

    const outcome = deliverTerminalAskOperation(
      operation,
      ctx.sessionManager.getBranch(),
      {
        send: (result, options) => {
          this.pi.sendMessage(
            {
              customType: ASYNC_ASK_RESULT_MESSAGE,
              content: result.content,
              display: true,
              details: result.details,
            },
            options,
          );
        },
        persist: (delivered) => {
          this.persist(delivered);
        },
      },
    );

    if (outcome === "sent") {
      this.deliveryPending.add(operation.operationId);
    } else if (outcome === "already_present") {
      this.deliveryPending.delete(operation.operationId);
    }

    if (outcome === "sent") {
      const verb = operation.status === "completed" ? "completed" : "failed";
      ctx.ui.notify(
        `Consultation ${verb} in ${operation.agentName} (${operation.paneId})`,
        operation.status === "completed" ? "info" : "error",
      );
    }
  }

  private persist(operation: AsyncAskOperation): void {
    this.pi.appendEntry(ASYNC_ASK_OPERATION_ENTRY, operation);
  }

  private isCurrentWorkingOperation(
    operation: AsyncAskOperation,
    ctx: ExtensionContext,
    generation: number,
  ): boolean {
    return (
      this.isCurrent(operation, ctx, generation) &&
      restoreAsyncAskOperations(ctx.sessionManager.getBranch()).get(
        operation.operationId,
      )?.status === "working"
    );
  }

  private isCurrent(
    operation: AsyncAskOperation,
    ctx: ExtensionContext,
    generation: number,
  ): boolean {
    return (
      generation === this.generation &&
      ctx.sessionManager.getSessionFile() === operation.originSession
    );
  }
}

export async function retryAskResultExtraction(
  extract: () => string,
  timeoutMs: number,
  intervalMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return extract();
    } catch (error) {
      if (!(error instanceof AskResultError) || Date.now() >= deadline) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function resolveAskSessionReference(
  target: AskTarget,
  session: AgentSessionReference | undefined,
): string | undefined {
  return target === "pi"
    ? resolvePiSessionReference(session)
    : resolveClaudeSessionReference(session);
}

function remainingAskTime(operation: AsyncAskOperation): number {
  const remaining = operation.deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new OrchestrationError(
      "consultation deadline elapsed during recovery",
      { code: "timeout" },
    );
  }
  return remaining;
}

function classifyAsyncAskFailure(error: unknown): AskOperationFailure {
  let reason: FailureReason = "prompt_failed";
  if (error instanceof OrchestrationError && error.code === "timeout") {
    reason = "timeout";
  } else if (error instanceof AskLaunchError && error.status === "blocked") {
    reason = "blocked";
  } else if (
    error instanceof AskLaunchError &&
    error.status !== undefined &&
    error.status !== "idle" &&
    error.status !== "done"
  ) {
    reason = "ambiguous_status";
  } else if (error instanceof AskResultError) {
    reason = "result_unavailable";
  }
  return { reason, message: errorMessage(error) };
}

function buildAsyncAskFailureResult(
  operation: AsyncAskOperation,
  failure: AskOperationFailure,
): StoredAskResult {
  const boundedQuestion = boundText(
    sanitizeTransferText(operation.question),
    QUESTION_EXCERPT_CHARACTERS,
  );
  const questionSuffix = boundedQuestion.truncated ? "…" : "";
  const references = [
    `pane ${operation.paneId}`,
    `agent name ${operation.agentName}`,
    operation.childSession === undefined
      ? undefined
      : `child session ${operation.childSession}`,
  ]
    .filter((value) => value !== undefined)
    .join(", ");

  return {
    content: [
      "# Portr consultation failed",
      "",
      `Question: ${boundedQuestion.text}${questionSuffix}`,
      `Destination references: ${references}`,
      `Failure: ${failure.message}`,
    ].join("\n"),
    details: {
      operationId: operation.operationId,
      target: operation.target,
      agentName: operation.agentName,
      paneId: operation.paneId,
      status: "failed",
      failureReason: failure.reason,
      originSession: operation.originSession,
      ...(operation.childSession === undefined
        ? {}
        : { childSession: operation.childSession }),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
