import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_PANES,
  readPortrSettings,
  registerPortrSettings,
  writePortrSettings,
} from "../src/settings.ts";

test("Portr settings default, persist, and reject invalid files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-portr-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "portr.json");

  assert.deepEqual(await readPortrSettings(path), {
    maxPanes: DEFAULT_MAX_PANES,
  });

  await writePortrSettings({ maxPanes: 6 }, path);
  assert.deepEqual(await readPortrSettings(path), { maxPanes: 6 });

  await writeFile(path, "{invalid", "utf8");
  await assert.rejects(() => readPortrSettings(path), /invalid JSON/);

  await writeFile(path, JSON.stringify({ maxPanes: 0 }), "utf8");
  await assert.rejects(() => readPortrSettings(path), /positive safe integer/);
});

test("portr_settings is model-discoverable and requires approval to change", async () => {
  let command: SettingsCommand | undefined;
  let tool: SettingsTool | undefined;
  let current = 4;
  let confirmed = false;
  const writes: number[] = [];
  const pi = {
    registerCommand: (_name: string, value: SettingsCommand) => {
      command = value;
    },
    registerTool: (value: SettingsTool) => {
      tool = value;
    },
  } as unknown as ExtensionAPI;
  registerPortrSettings(pi, {
    read: async () => ({ maxPanes: current }),
    write: async ({ maxPanes }) => {
      current = maxPanes;
      writes.push(maxPanes);
    },
  });

  assert.ok(tool);
  const registeredTool = tool as SettingsTool;
  assert.match(registeredTool.promptSnippet ?? "", /pi-portr settings/);
  assert.match(
    registeredTool.promptGuidelines?.join(" ") ?? "",
    /explicit user/,
  );

  const shown = await registeredTool.execute(
    "tool-1",
    { action: "show" },
    undefined,
    undefined,
    { hasUI: false } as ExtensionContext,
  );
  assert.match(shown?.content[0]?.text ?? "", /maxPanes is 4/);

  const context = {
    hasUI: true,
    ui: { confirm: async () => confirmed },
  } as unknown as ExtensionContext;
  const declined = await registeredTool.execute(
    "tool-2",
    { action: "request_change", maxPanes: 6 },
    undefined,
    undefined,
    context,
  );
  assert.match(declined?.content[0]?.text ?? "", /unchanged/);
  assert.deepEqual(writes, []);

  confirmed = true;
  const changed = await registeredTool.execute(
    "tool-3",
    { action: "request_change", maxPanes: 6 },
    undefined,
    undefined,
    context,
  );
  assert.match(changed?.content[0]?.text ?? "", /changed from 4 to 6/);
  assert.deepEqual(writes, [6]);

  await assert.rejects(
    () =>
      registeredTool.execute(
        "tool-4",
        { action: "request_change", maxPanes: 7 },
        undefined,
        undefined,
        { hasUI: false } as ExtensionContext,
      ),
    /requires human approval/,
  );

  assert.ok(command);
});

test("portr-settings command writes only after confirmation", async () => {
  let command: SettingsCommand | undefined;
  const writes: number[] = [];
  let confirmed = false;
  const pi = {
    registerCommand: (_name: string, value: SettingsCommand) => {
      command = value;
    },
    registerTool: () => undefined,
  } as unknown as ExtensionAPI;
  registerPortrSettings(pi, {
    read: async () => ({ maxPanes: 4 }),
    write: async ({ maxPanes }) => {
      writes.push(maxPanes);
    },
  });
  const context = {
    hasUI: true,
    ui: {
      input: async () => "6",
      confirm: async () => confirmed,
      notify: () => undefined,
    },
  } as unknown as ExtensionCommandContext;

  await command?.handler("", context);
  assert.deepEqual(writes, []);

  confirmed = true;
  await command?.handler("", context);
  assert.deepEqual(writes, [6]);
});

interface SettingsCommand {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

interface SettingsToolResult {
  content: Array<{ type: string; text?: string }>;
}

interface SettingsTool {
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    parameters: { action: "show" | "request_change"; maxPanes?: number },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<SettingsToolResult>;
}
