export const AGENT_STATUSES = [
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentTarget = "pi" | "claude";

export type AgentSessionReference =
  | { agent: "pi"; kind: "path"; value: string }
  | { agent: "claude"; kind: "id"; value: string };

export interface AgentState {
  status: AgentStatus;
  paneId: string;
  session?: AgentSessionReference;
}

export interface SplitPaneOptions {
  paneId: string;
  cwd: string;
  direction: "right" | "down";
}

export interface PaneLayout {
  paneCount: number;
  origin: {
    width: number;
    height: number;
  };
}

export interface Orchestrator {
  currentPane(): Promise<string>;
  paneLayout(paneId: string): Promise<PaneLayout>;
  splitPane(options: SplitPaneOptions): Promise<string>;
  paneIsFocused(paneId: string): Promise<boolean>;
  promptUntilWorking(
    agentName: string,
    prompt: string,
    timeoutMs?: number,
  ): Promise<AgentState>;
  promptAndWait(
    agentName: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<AgentState>;
  getAgent(agentName: string): Promise<AgentState>;
  waitForAgent(
    agentName: string,
    timeoutMs: number,
    until?: readonly AgentStatus[],
  ): Promise<AgentState>;
  focus(agentName: string): Promise<void>;
  startAgent(
    target: AgentTarget,
    agentName: string,
    paneId: string,
    agentArgs: readonly string[],
  ): Promise<void>;
}

export type CreateOrchestrator = () => Orchestrator;

export interface OrchestrationErrorOptions extends ErrorOptions {
  code?: string;
}

export class OrchestrationError extends Error {
  readonly code: string | undefined;

  constructor(message: string, options?: OrchestrationErrorOptions) {
    super(message, options);
    this.name = "OrchestrationError";
    this.code = options?.code;
  }
}

export class PaneLimitReachedError extends OrchestrationError {
  readonly currentPanes: number;
  readonly maxPanes: number;
  readonly retryable = false;

  constructor(currentPanes: number, maxPanes: number) {
    super(
      `Portr pane limit reached (${currentPanes}/${maxPanes}); no pane was created. Do not retry automatically. Continue in the current session or report the blocker to the parent. A human can change maxPanes with /portr-settings or portr_settings.`,
      { code: "pane_limit_reached" },
    );
    this.name = "PaneLimitReachedError";
    this.currentPanes = currentPanes;
    this.maxPanes = maxPanes;
  }
}

export async function createDestinationPane(
  orchestrator: Orchestrator,
  options: {
    originPaneId: string;
    cwd: string;
    maxPanes: number;
  },
): Promise<string> {
  if (!Number.isSafeInteger(options.maxPanes) || options.maxPanes <= 0) {
    throw new RangeError("maxPanes must be a positive safe integer");
  }

  const layout = await orchestrator.paneLayout(options.originPaneId);
  if (layout.paneCount >= options.maxPanes) {
    throw new PaneLimitReachedError(layout.paneCount, options.maxPanes);
  }

  return orchestrator.splitPane({
    paneId: options.originPaneId,
    cwd: options.cwd,
    direction:
      layout.origin.width >= layout.origin.height * 2 ? "right" : "down",
  });
}
