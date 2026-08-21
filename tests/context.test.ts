import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  boundText,
  boundTextFromEnd,
  buildTransferContext,
  serializeTransferMessages,
} from "../src/context.ts";

test("boundText preserves content that fits the limit", () => {
  assert.deepEqual(boundText("context", 10), {
    text: "context",
    truncated: false,
    originalLength: 7,
  });
});

test("boundText reports deterministic truncation", () => {
  assert.deepEqual(boundText("context", 4), {
    text: "cont",
    truncated: true,
    originalLength: 7,
  });
});

test("boundTextFromEnd keeps recent context and reports omission", () => {
  assert.deepEqual(boundTextFromEnd("0123456789", 5), {
    text: "56789",
    truncated: true,
    originalLength: 10,
  });
});

test("text bounds reject invalid limits", () => {
  assert.throws(() => boundText("context", 0), RangeError);
  assert.throws(() => boundTextFromEnd("context", 1.5), RangeError);
});

test("transfer serialization excludes thinking, images, and tool output", () => {
  const serialized = serializeTransferMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect src/index.ts" },
        { type: "image", data: "base64-secret", mimeType: "image/png" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        { type: "text", text: "The entrypoint registers two commands." },
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "src/index.ts", offset: 1 },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "large tool output" }],
    },
    {
      role: "custom",
      content: "hidden extension message",
    },
  ]);

  assert.match(serialized, /Inspect src\/index\.ts/);
  assert.match(serialized, /entrypoint registers two commands/);
  assert.match(serialized, /read\(src\/index\.ts\)/);
  assert.match(serialized, /output omitted/);
  assert.doesNotMatch(serialized, /hidden chain of thought/);
  assert.doesNotMatch(serialized, /base64-secret/);
  assert.doesNotMatch(serialized, /large tool output/);
  assert.doesNotMatch(serialized, /hidden extension message/);
});

test("transfer serialization removes textual data URLs", () => {
  const serialized = serializeTransferMessages([
    {
      role: "user",
      content: "Image: data:image/png;base64,AAABBBCCC==",
    },
  ]);

  assert.equal(serialized, "User: Image: [base64 data omitted]");
});

test("buildTransferContext follows Pi compaction context", () => {
  const entries: SessionEntry[] = [
    messageEntry("old", null, "Old context that was compacted"),
    messageEntry("kept", "old", "Kept context"),
    {
      type: "compaction",
      id: "compaction",
      parentId: "kept",
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "Summary of old context",
      firstKeptEntryId: "kept",
      tokensBefore: 100,
    },
    messageEntry("recent", "compaction", "Recent context"),
  ];
  const sessionManager = {
    getEntries: () => entries,
    getLeafId: () => "recent",
  } satisfies Pick<SessionManager, "getEntries" | "getLeafId">;

  const result = buildTransferContext(sessionManager);

  assert.match(result.text, /Summary of old context/);
  assert.match(result.text, /Kept context/);
  assert.match(result.text, /Recent context/);
  assert.doesNotMatch(result.text, /Old context that was compacted/);
});

function messageEntry(
  id: string,
  parentId: string | null,
  text: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: text,
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    },
  };
}
