import { execFile } from "node:child_process";

export const HERDR_EXECUTABLE = "herdr";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const AGENT_START_TIMEOUT_MS = 30_000;
const AGENT_START_BUSY_RETRY_TIMEOUT_MS = 2_000;
const AGENT_START_BUSY_POLL_INTERVAL_MS = 100;
const MAX_OUTPUT_BYTES = 1_048_576;

export interface HerdrInvocation {
  executable: string;
  args: string[];
}

export interface HerdrProcessOutput {
  stdout: string;
  stderr: string;
}

export type HerdrCommandRunner = (
  invocation: HerdrInvocation,
  timeoutMs: number,
) => Promise<HerdrProcessOutput>;

export interface HerdrPane {
  paneId: string;
}

export interface SplitPaneOptions {
  paneId: string;
  cwd: string;
  direction: "right" | "down";
}

export const HERDR_AGENT_STATUSES = [
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
] as const;

export type HerdrAgentStatus = (typeof HERDR_AGENT_STATUSES)[number];

export interface HerdrAgent {
  status: HerdrAgentStatus;
  paneId: string;
  sessionPath?: string;
  sessionId?: string;
}

export interface HerdrCommandErrorOptions extends ErrorOptions {
  code?: string;
}

export class HerdrCommandError extends Error {
  readonly operation: string;
  readonly stderr: string;
  readonly code: string | undefined;

  constructor(
    operation: string,
    message: string,
    stderr = "",
    options?: HerdrCommandErrorOptions,
  ) {
    super(message, options);
    this.name = "HerdrCommandError";
    this.operation = operation;
    this.stderr = stderr;
    this.code = options?.code;
  }
}

export class HerdrClient {
  private readonly runner: HerdrCommandRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    runner: HerdrCommandRunner = runHerdrCommand,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.runner = runner;
    this.environment = environment;
  }

  async currentPane(): Promise<HerdrPane> {
    if (this.environment.HERDR_ENV !== "1") {
      throw new HerdrCommandError(
        "preflight",
        "pi-portr must run inside a Herdr-managed pane",
      );
    }

    const result = await this.execute(["pane", "current", "--current"]);
    return { paneId: readPaneId(result, "pane current") };
  }

  async splitPane(options: SplitPaneOptions): Promise<HerdrPane> {
    const result = await this.execute([
      "pane",
      "split",
      "--pane",
      options.paneId,
      "--direction",
      options.direction,
      "--cwd",
      options.cwd,
      "--no-focus",
    ]);
    return { paneId: readPaneId(result, "pane split") };
  }

  async paneIsFocused(paneId: string): Promise<boolean> {
    const result = await this.execute(["pane", "get", paneId]);
    return readPaneFocused(result, "pane get");
  }

  async startPi(
    agentName: string,
    paneId: string,
    piArgs: readonly string[],
  ): Promise<void> {
    await this.startAgent("pi", agentName, paneId, piArgs);
  }

  async startClaude(
    agentName: string,
    paneId: string,
    claudeArgs: readonly string[],
  ): Promise<void> {
    await this.startAgent("claude", agentName, paneId, claudeArgs);
  }

  async prompt(agentName: string, prompt: string): Promise<void> {
    await this.execute(["agent", "prompt", agentName, prompt]);
  }

  async promptUntilWorking(
    agentName: string,
    prompt: string,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<HerdrAgent> {
    validateTimeout(timeoutMs);
    const result = await this.execute(
      [
        "agent",
        "prompt",
        agentName,
        prompt,
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        String(timeoutMs),
      ],
      timeoutMs + 5_000,
    );
    return readAgent(result, "agent prompt");
  }

  async promptAndWait(
    agentName: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<HerdrAgent> {
    validateTimeout(timeoutMs);
    const result = await this.execute(
      [
        "agent",
        "prompt",
        agentName,
        prompt,
        "--wait",
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(timeoutMs),
      ],
      timeoutMs + 5_000,
    );
    return readAgent(result, "agent prompt");
  }

  async getAgent(agentName: string): Promise<HerdrAgent> {
    const result = await this.execute(["agent", "get", agentName]);
    return readAgent(result, "agent get");
  }

  async waitForAgent(
    agentName: string,
    timeoutMs: number,
    until: readonly HerdrAgentStatus[] = ["idle", "done", "blocked"],
  ): Promise<HerdrAgent> {
    validateTimeout(timeoutMs);
    if (until.length === 0) {
      throw new RangeError("until must include at least one agent status");
    }

    const args = ["agent", "wait", agentName];
    for (const status of until) {
      args.push("--until", status);
    }
    args.push("--timeout", String(timeoutMs));

    const result = await this.execute(args, timeoutMs + 5_000);
    return readAgent(result, "agent wait");
  }

  async focus(agentName: string): Promise<void> {
    await this.execute(["agent", "focus", agentName]);
  }

  private async startAgent(
    kind: "pi" | "claude",
    agentName: string,
    paneId: string,
    agentArgs: readonly string[],
  ): Promise<void> {
    const args = [
      "agent",
      "start",
      agentName,
      "--kind",
      kind,
      "--pane",
      paneId,
      "--timeout",
      String(AGENT_START_TIMEOUT_MS),
    ];

    if (agentArgs.length > 0) {
      args.push("--", ...agentArgs);
    }

    const terminalId = await this.paneTerminalId(paneId);
    const retryDeadline = Date.now() + AGENT_START_BUSY_RETRY_TIMEOUT_MS;

    while (true) {
      try {
        await this.execute(args, AGENT_START_TIMEOUT_MS + 5_000);
        return;
      } catch (error) {
        if (
          !(error instanceof HerdrCommandError) ||
          error.code !== "agent_pane_busy" ||
          Date.now() >= retryDeadline
        ) {
          throw error;
        }

        let terminalUnchanged: boolean;
        try {
          terminalUnchanged =
            (await this.paneTerminalId(paneId)) === terminalId;
        } catch {
          throw error;
        }
        if (!terminalUnchanged) {
          throw error;
        }

        let shellInitializing: boolean;
        try {
          shellInitializing = await this.paneShellIsInitializing(paneId);
        } catch {
          throw error;
        }
        if (!shellInitializing) {
          throw error;
        }

        await delay(AGENT_START_BUSY_POLL_INTERVAL_MS);
      }
    }
  }

  private async paneTerminalId(paneId: string): Promise<string> {
    const result = await this.execute(["pane", "get", paneId]);
    return readTerminalId(result, "pane get");
  }

  private async paneShellIsInitializing(paneId: string): Promise<boolean> {
    const result = await this.execute(
      ["pane", "process-info", "--pane", paneId],
      1_000,
    );
    return isPaneShellInitializing(result);
  }

  private async execute(
    args: readonly string[],
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const invocation = createHerdrInvocation(args);
    const output = await this.runner(invocation, timeoutMs);
    return parseHerdrResult(output.stdout, operationName(args));
  }
}

export function createHerdrInvocation(
  args: readonly string[],
  executable = HERDR_EXECUTABLE,
): HerdrInvocation {
  return {
    executable,
    args: [...args],
  };
}

export const runHerdrCommand: HerdrCommandRunner = (invocation, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      invocation.executable,
      invocation.args,
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const stderrText = stderr.trim();
          const herdrError = parseHerdrError(stderrText);
          const diagnostic =
            herdrError?.message ?? (stderrText || error.message);
          reject(
            new HerdrCommandError(
              operationName(invocation.args),
              diagnostic,
              stderrText,
              herdrError === undefined
                ? { cause: error }
                : { cause: error, code: herdrError.code },
            ),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });

export function parseHerdrError(
  output: string,
): { code: string; message: string } | undefined {
  try {
    const envelope: unknown = JSON.parse(output);
    if (
      !isRecord(envelope) ||
      !isRecord(envelope.error) ||
      typeof envelope.error.code !== "string" ||
      typeof envelope.error.message !== "string"
    ) {
      return undefined;
    }
    return { code: envelope.error.code, message: envelope.error.message };
  } catch {
    return undefined;
  }
}

export function parseHerdrResult(output: string, operation: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(output);
  } catch (error) {
    throw new HerdrCommandError(
      operation,
      `Herdr returned invalid JSON for ${operation}`,
      "",
      { cause: error },
    );
  }

  if (!isRecord(envelope) || !("result" in envelope)) {
    throw new HerdrCommandError(
      operation,
      `Herdr returned an invalid response for ${operation}`,
    );
  }

  return envelope.result;
}

function readPaneId(result: unknown, operation: string): string {
  if (!isRecord(result) || !isRecord(result.pane)) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include a pane`,
    );
  }

  const paneId = result.pane.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include a pane ID`,
    );
  }

  return paneId;
}

function readTerminalId(result: unknown, operation: string): string {
  if (!isRecord(result) || !isRecord(result.pane)) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include a pane`,
    );
  }

  const terminalId = result.pane.terminal_id;
  if (typeof terminalId !== "string" || terminalId.length === 0) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include a terminal ID`,
    );
  }

  return terminalId;
}

function readPaneFocused(result: unknown, operation: string): boolean {
  if (!isRecord(result) || !isRecord(result.pane)) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include a pane`,
    );
  }

  const focused = result.pane.focused;
  if (typeof focused !== "boolean") {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include focus state`,
    );
  }

  return focused;
}

function readAgent(result: unknown, operation: string): HerdrAgent {
  if (!isRecord(result) || !isRecord(result.agent)) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include an agent`,
    );
  }

  const status = result.agent.agent_status;
  if (!isHerdrAgentStatus(status)) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} included an invalid agent status`,
    );
  }

  const paneId = result.agent.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new HerdrCommandError(
      operation,
      `Herdr response for ${operation} did not include a pane ID`,
    );
  }

  const session = result.agent.agent_session;
  const sessionRecord = isRecord(session) ? session : undefined;
  const sessionValue =
    sessionRecord !== undefined &&
    typeof sessionRecord.value === "string" &&
    sessionRecord.value.length > 0
      ? sessionRecord.value
      : undefined;
  const sessionPath =
    sessionValue !== undefined &&
    sessionRecord?.agent === "pi" &&
    sessionRecord.kind === "path"
      ? sessionValue
      : undefined;
  const sessionId =
    sessionValue !== undefined &&
    sessionRecord?.agent === "claude" &&
    sessionRecord.kind === "id"
      ? sessionValue
      : undefined;

  return {
    status,
    paneId,
    ...(sessionPath === undefined ? {} : { sessionPath }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > Number.MAX_SAFE_INTEGER - 5_000
  ) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
}

function isHerdrAgentStatus(value: unknown): value is HerdrAgentStatus {
  return (
    typeof value === "string" &&
    HERDR_AGENT_STATUSES.includes(value as HerdrAgentStatus)
  );
}

function isPaneShellInitializing(result: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.process_info)) {
    return false;
  }

  const shellPid = result.process_info.shell_pid;
  const foregroundProcessGroupId =
    result.process_info.foreground_process_group_id;
  const foregroundProcesses = result.process_info.foreground_processes;
  return (
    typeof shellPid === "number" &&
    foregroundProcessGroupId === shellPid &&
    Array.isArray(foregroundProcesses) &&
    foregroundProcesses.some(
      (process) => isRecord(process) && process.pid === shellPid,
    )
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function operationName(args: readonly string[]): string {
  return args.slice(0, 2).join(" ") || "herdr";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
