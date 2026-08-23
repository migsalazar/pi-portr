import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
export const DEFAULT_MAX_PANES = 4;

const SETTINGS_TOOL_PARAMETERS = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["show", "request_change"] },
    maxPanes: {
      type: "integer",
      minimum: 1,
      description: "Requested maximum pane count",
    },
  },
} as const;

export interface PortrSettings {
  maxPanes: number;
}

export type LoadPortrSettings = () => Promise<PortrSettings>;

export function portrSettingsPath(): string {
  return join(getAgentDir(), "portr.json");
}

export async function readPortrSettings(
  path = portrSettingsPath(),
): Promise<PortrSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { maxPanes: DEFAULT_MAX_PANES };
    }
    throw new Error(`Could not read Portr settings at ${path}`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Portr settings at ${path} contain invalid JSON`, {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new Error(`Portr settings at ${path} must be a JSON object`);
  }

  return {
    maxPanes:
      value.maxPanes === undefined
        ? DEFAULT_MAX_PANES
        : validateMaxPanes(value.maxPanes),
  };
}

export async function writePortrSettings(
  settings: PortrSettings,
  path = portrSettingsPath(),
): Promise<void> {
  const maxPanes = validateMaxPanes(settings.maxPanes);
  await writeFile(path, `${JSON.stringify({ maxPanes }, null, 2)}\n`, "utf8");
}

export function registerPortrSettings(
  pi: ExtensionAPI,
  dependencies: {
    read?: LoadPortrSettings;
    write?: (settings: PortrSettings) => Promise<void>;
  } = {},
): void {
  const read = dependencies.read ?? readPortrSettings;
  const write = dependencies.write ?? writePortrSettings;

  pi.registerCommand("portr-settings", {
    description: "View or change the Portr pane limit",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /portr-settings", "error");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/portr-settings requires an interactive UI", "error");
        return;
      }

      try {
        const current = await read();
        const raw = await ctx.ui.input(
          `Portr maximum panes (current: ${current.maxPanes})`,
          "Positive integer",
        );
        if (raw === undefined) {
          return;
        }

        const maxPanes = parseMaxPanes(raw);
        if (maxPanes === current.maxPanes) {
          ctx.ui.notify(`Portr maxPanes is already ${maxPanes}`, "info");
          return;
        }

        const confirmed = await ctx.ui.confirm(
          "Change Portr pane limit?",
          `${current.maxPanes} → ${maxPanes}`,
        );
        if (!confirmed) {
          ctx.ui.notify("Portr settings unchanged", "info");
          return;
        }

        await write({ maxPanes });
        ctx.ui.notify(`Portr maxPanes changed to ${maxPanes}`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "portr_settings",
    label: "Portr settings",
    description:
      "Inspect pi-portr settings or request a user-approved change to the maximum pane count.",
    promptSnippet:
      "Inspect pi-portr settings or request a user-approved pane limit change",
    promptGuidelines: [
      "Use portr_settings when the user asks how to configure pi-portr.",
      "Never use portr_settings to increase maxPanes automatically after a pane-limit refusal; require an explicit user request.",
    ],
    parameters: SETTINGS_TOOL_PARAMETERS as never,
    async execute(_toolCallId, rawParameters, _signal, _onUpdate, ctx) {
      const parameters = rawParameters as unknown as {
        action: "show" | "request_change";
        maxPanes?: number;
      };
      const current = await read();
      if (parameters.action === "show") {
        return {
          content: [
            {
              type: "text",
              text: `Portr maxPanes is ${current.maxPanes} (default ${DEFAULT_MAX_PANES}). It counts every pane in the current Herdr tab. A human can change it with /portr-settings or request a user-approved change through this tool.`,
            },
          ],
          details: {
            maxPanes: current.maxPanes,
            defaultMaxPanes: DEFAULT_MAX_PANES,
            changed: false,
          },
        };
      }

      const maxPanes = validateMaxPanes(parameters.maxPanes);
      if (maxPanes === current.maxPanes) {
        return {
          content: [
            { type: "text", text: `Portr maxPanes is already ${maxPanes}.` },
          ],
          details: { maxPanes, changed: false },
        };
      }
      if (!ctx.hasUI) {
        throw new Error(
          `Changing Portr maxPanes requires human approval; use /portr-settings in interactive Pi`,
        );
      }

      const confirmed = await ctx.ui.confirm(
        "Change Portr pane limit?",
        `${current.maxPanes} → ${maxPanes}`,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Portr settings unchanged." }],
          details: { maxPanes: current.maxPanes, changed: false },
        };
      }

      await write({ maxPanes });
      return {
        content: [
          {
            type: "text",
            text: `Portr maxPanes changed from ${current.maxPanes} to ${maxPanes}. Previously refused operations were not retried.`,
          },
        ],
        details: { maxPanes, changed: true },
      };
    },
  });
}

function parseMaxPanes(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("maxPanes must be a positive integer");
  }
  return validateMaxPanes(Number(value));
}

function validateMaxPanes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("maxPanes must be a positive safe integer");
  }
  return value as number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
