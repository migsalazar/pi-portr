import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerPassCommand(pi: ExtensionAPI): void {
  pi.registerCommand("portr-pass", {
    description: "Hand off work to another visible agent session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("/portr-pass is not implemented yet", "warning");
    },
  });
}
