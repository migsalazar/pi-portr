import { randomUUID } from "node:crypto";
import {
  BorderedLoader,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export type GenerationResult =
  | { status: "ok"; text: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export async function generateTransferText(
  ctx: ExtensionCommandContext,
  options: { label: string; systemPrompt: string; prompt: string },
): Promise<GenerationResult> {
  const model = ctx.model;
  if (model === undefined) {
    return { status: "error", message: "No model selected" };
  }

  return ctx.ui.custom<GenerationResult>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, options.label);
    loader.onAbort = () => done({ status: "cancelled" });

    const generate = async (): Promise<GenerationResult> => {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: options.systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: options.prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal: loader.signal,
          cacheRetention: "none",
          sessionId: randomUUID(),
        },
      );

      if (loader.signal.aborted || response.stopReason === "aborted") {
        return { status: "cancelled" };
      }
      if (response.stopReason !== "stop") {
        return {
          status: "error",
          message: `Model stopped with ${response.stopReason}`,
        };
      }

      const text = response.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n")
        .trim();

      return text.length === 0
        ? { status: "error", message: "Model returned no text" }
        : { status: "ok", text };
    };

    generate()
      .then(done)
      .catch((error: unknown) => {
        done(
          loader.signal.aborted
            ? { status: "cancelled" }
            : {
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              },
        );
      });

    return loader;
  });
}
