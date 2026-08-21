import { execFile } from "node:child_process";

export const HERDR_EXECUTABLE = "herdr";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const AGENT_START_TIMEOUT_MS = 30_000;
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

export class HerdrCommandError extends Error {
  readonly operation: string;
  readonly stderr: string;

  constructor(
    operation: string,
    message: string,
    stderr = "",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HerdrCommandError";
    this.operation = operation;
    this.stderr = stderr;
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

  async startPi(
    agentName: string,
    paneId: string,
    piArgs: readonly string[],
  ): Promise<void> {
    const args = [
      "agent",
      "start",
      agentName,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--timeout",
      String(AGENT_START_TIMEOUT_MS),
    ];

    if (piArgs.length > 0) {
      args.push("--", ...piArgs);
    }

    await this.execute(args, AGENT_START_TIMEOUT_MS + 5_000);
  }

  async prompt(agentName: string, prompt: string): Promise<void> {
    await this.execute(["agent", "prompt", agentName, prompt]);
  }

  async focus(agentName: string): Promise<void> {
    await this.execute(["agent", "focus", agentName]);
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
          const diagnostic = stderr.trim() || error.message;
          reject(
            new HerdrCommandError(
              operationName(invocation.args),
              diagnostic,
              stderr.trim(),
              { cause: error },
            ),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });

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

function operationName(args: readonly string[]): string {
  return args.slice(0, 2).join(" ") || "herdr";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
