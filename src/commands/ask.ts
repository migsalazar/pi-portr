import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerAskCommand(pi: ExtensionAPI): void {
  pi.registerCommand("portr-ask", {
    description: "Ask a question in another visible agent session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("/portr-ask is not implemented yet", "warning");
    },
  });
}
