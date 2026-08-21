import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskCommand } from "./commands/ask.ts";
import { registerPassCommand } from "./commands/pass.ts";

export default function portr(pi: ExtensionAPI): void {
  registerPassCommand(pi);
  registerAskCommand(pi);
}
