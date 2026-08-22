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

export interface Orchestrator {
  currentPane(): Promise<string>;
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
