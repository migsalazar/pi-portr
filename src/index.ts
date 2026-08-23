import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskCommand } from "./commands/ask.ts";
import { registerOperationCommands } from "./commands/operations.ts";
import { registerPassCommand } from "./commands/pass.ts";
import { HerdrClient } from "./herdr.ts";
import type { CreateOrchestrator } from "./orchestrator.ts";
import { registerPortrSettings } from "./settings.ts";

export default function portr(pi: ExtensionAPI): void {
  const createOrchestrator: CreateOrchestrator = () => new HerdrClient();
  registerPortrSettings(pi);
  registerPassCommand(pi, createOrchestrator);
  registerAskCommand(pi, createOrchestrator);
  registerOperationCommands(pi, createOrchestrator);
}
