export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface PiLaunchOptions {
  readOnly: boolean;
  model?: string;
}

export function buildPiLaunchArgs(options: PiLaunchOptions): string[] {
  const args: string[] = [];

  if (options.readOnly) {
    args.push("--tools", PI_READ_ONLY_TOOLS.join(","));
  }

  if (options.model !== undefined) {
    const model = options.model.trim();
    if (model.length === 0) {
      throw new Error("model must not be empty");
    }
    args.push("--model", model);
  }

  return args;
}
