import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionContext,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  boundText,
  buildTransferContext,
  serializeTransferMessages,
} from "../src/context.ts";
import { buildAskPrompt } from "../src/commands/ask.ts";

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];

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

test("text bounds reject invalid limits", () => {
  assert.throws(() => boundText("context", 0), RangeError);
  assert.throws(() => boundText("context", 1.5), RangeError);
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

test("transfer serialization removes parameterized and uppercase data URLs", () => {
  const serialized = serializeTransferMessages([
    {
      role: "user",
      content: [
        "Parameterized: data:image/png;charset=utf-8;base64,QUJD",
        "Uppercase: DATA:IMAGE/PNG;BASE64,REVG",
      ].join("\n"),
    },
  ]);

  assert.equal(
    serialized,
    [
      "User: Parameterized: [base64 data omitted]",
      "Uppercase: [base64 data omitted]",
    ].join("\n"),
  );
});

test("transfer truncation does not retain orphaned tool results", () => {
  const entries: SessionEntry[] = [
    messageEntry("old", null, "OLD ".repeat(200)),
    agentMessageEntry("assistant", "old", {
      role: "assistant",
      content: [
        { type: "text", text: "DETAIL ".repeat(30) },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "src/index.ts" },
        },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
    }),
    agentMessageEntry("tool-result", "assistant", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "omitted production output" }],
      isError: false,
      timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
    }),
    messageEntry("recent", "tool-result", "RECENT-QUESTION"),
  ];
  const sessionManager = contextSession(entries, "recent");

  const orphanBound = buildTransferContext(sessionManager, 120);
  assert.equal(orphanBound.truncated, true);
  assert.ok(orphanBound.text.length <= 120);
  assert.match(orphanBound.text, /Earlier messages omitted due to size/);
  assert.match(orphanBound.text, /RECENT-QUESTION/);
  assert.doesNotMatch(orphanBound.text, /Tool read/);
  assert.doesNotMatch(orphanBound.text, /Assistant:/);

  const latestToolBound = buildTransferContext(
    contextSession(entries.slice(0, -1), "tool-result"),
    120,
  );
  assert.equal(latestToolBound.text, "[Earlier messages omitted due to size]");
  assert.equal(latestToolBound.truncated, true);

  const pairBound = buildTransferContext(sessionManager, 400);
  assert.equal(pairBound.truncated, true);
  assert.ok(pairBound.text.length <= 400);
  assert.match(pairBound.text, /Assistant: DETAIL/);
  assert.match(pairBound.text, /Tool read: completed/);
  assert.match(pairBound.text, /RECENT-QUESTION/);
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
  const sessionManager = contextSession(entries, "recent");

  const result = buildTransferContext(sessionManager);

  assert.match(result.text, /Summary of old context/);
  assert.match(result.text, /Kept context/);
  assert.match(result.text, /Recent context/);
  assert.doesNotMatch(result.text, /Old context that was compacted/);
});

test("preserves compaction and recent context through the Ask prompt", () => {
  const recent = [
    "TRANSFER-BEGIN",
    "a".repeat(100),
    "TRANSFER-MIDDLE",
    "b".repeat(100),
    "TRANSFER-END",
  ].join("\n");
  const entries: SessionEntry[] = [
    messageEntry("old", null, "Old compacted text"),
    messageEntry("kept", "old", "Kept tail"),
    {
      type: "compaction",
      id: "compaction",
      parentId: "kept",
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "DECISION-ONLY-IN-COMPACTION",
      firstKeptEntryId: "kept",
      tokensBefore: 100,
    },
    messageEntry("recent", "compaction", recent),
  ];
  const sessionManager = contextSession(entries, "recent");

  const resolved = buildSessionContext(entries, "recent");
  assert.deepEqual(
    resolved.messages.map((message) => message.role),
    ["compactionSummary", "user", "user"],
  );

  const serialized = serializeTransferMessages(resolved.messages);
  assert.match(serialized, /DECISION-ONLY-IN-COMPACTION/);
  assert.match(serialized, /TRANSFER-BEGIN/);
  assert.match(serialized, /TRANSFER-MIDDLE/);
  assert.match(serialized, /TRANSFER-END/);

  const bounded = buildTransferContext(sessionManager, 220);
  assert.equal(bounded.text.length, 220);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.originalLength, serialized.length);
  assert.match(bounded.text, /DECISION-ONLY-IN-COMPACTION/);
  assert.doesNotMatch(bounded.text, /TRANSFER-BEGIN/);
  assert.match(bounded.text, /TRANSFER-MIDDLE/);
  assert.match(bounded.text, /TRANSFER-END/);

  const prompt = buildAskPrompt(bounded.text, "Which markers survived?");
  assert.match(prompt, /\nDECISION-ONLY-IN-COMPACTION/);
  assert.doesNotMatch(prompt, /TRANSFER-BEGIN/);
  assert.match(prompt, /\nTRANSFER-MIDDLE/);
  assert.match(prompt, /\nTRANSFER-END/);
});

test("preserves both ends when compaction alone exceeds the limit", () => {
  const summary = [
    "SUMMARY-BEGIN",
    "a".repeat(200),
    "SUMMARY-MIDDLE",
    "b".repeat(200),
    "SUMMARY-END",
  ].join("\n");
  const entries: SessionEntry[] = [
    messageEntry("old", null, "Old compacted text"),
    {
      type: "compaction",
      id: "compaction",
      parentId: "old",
      timestamp: "2026-01-01T00:00:01.000Z",
      summary,
      firstKeptEntryId: "old",
      tokensBefore: 100,
    },
    messageEntry("recent", "compaction", "RECENT-MUST-BE-OMITTED"),
  ];

  const bounded = buildTransferContext(contextSession(entries, "recent"), 160);

  assert.equal(bounded.text.length, 160);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.originalLength > bounded.text.length);
  assert.match(bounded.text, /Compacted context:/);
  assert.match(bounded.text, /SUMMARY-BEGIN/);
  assert.match(bounded.text, /Middle of compacted context omitted due to size/);
  assert.match(bounded.text, /SUMMARY-END/);
  assert.doesNotMatch(bounded.text, /SUMMARY-MIDDLE/);
  assert.doesNotMatch(bounded.text, /RECENT-MUST-BE-OMITTED/);
});

test("preserves visible Portr results after Pi context reconstruction", () => {
  const entries: SessionEntry[] = [
    messageEntry("origin", null, `ORIGIN-MARKER\n${"old ".repeat(200)}`),
    {
      type: "custom_message",
      id: "ask-result",
      parentId: "origin",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "portr-ask-result",
      content: "# Portr consultation result\n\nASK-RESULT-MARKER",
      display: true,
      details: { operationId: "operation-1" },
    },
    {
      type: "custom_message",
      id: "hidden-ask-result",
      parentId: "ask-result",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "portr-ask-result",
      content: "HIDDEN-ASK-RESULT-MARKER",
      display: false,
    },
    {
      type: "custom_message",
      id: "other-custom",
      parentId: "hidden-ask-result",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "another-extension",
      content: "OTHER-CUSTOM-MARKER",
      display: true,
    },
    messageEntry("recent", "other-custom", "RECENT-MARKER"),
  ];
  const sessionManager = contextSession(entries, "recent");

  const resolved = buildSessionContext(entries, "recent");
  assert.deepEqual(
    resolved.messages.map((message) => message.role),
    ["user", "custom", "custom", "custom", "user"],
  );
  assert.match(JSON.stringify(resolved.messages[1]), /ASK-RESULT-MARKER/);

  const serialized = serializeTransferMessages(resolved.messages);
  assert.match(serialized, /ORIGIN-MARKER/);
  assert.match(serialized, /# Portr consultation result/);
  assert.doesNotMatch(
    serialized,
    /Prior Portr consultation: # Portr consultation result/,
  );
  assert.match(serialized, /ASK-RESULT-MARKER/);
  assert.match(serialized, /RECENT-MARKER/);
  assert.doesNotMatch(serialized, /HIDDEN-ASK-RESULT-MARKER/);
  assert.doesNotMatch(serialized, /OTHER-CUSTOM-MARKER/);

  const bounded = buildTransferContext(sessionManager, 250);
  assert.equal(bounded.truncated, true);
  assert.match(bounded.text, /Earlier messages omitted due to size/);
  assert.doesNotMatch(bounded.text, /ORIGIN-MARKER/);
  assert.match(bounded.text, /ASK-RESULT-MARKER/);
  assert.match(
    buildAskPrompt(bounded.text, "What did the consultation conclude?"),
    /\nASK-RESULT-MARKER/,
  );
});

test("preserves Pi branch summaries in transfer context", () => {
  const entries: SessionEntry[] = [
    messageEntry("root", null, "Root context"),
    {
      type: "branch_summary",
      id: "branch-summary",
      parentId: "root",
      timestamp: "2026-01-01T00:00:01.000Z",
      fromId: "abandoned-branch",
      summary: "BRANCH-SUMMARY-MARKER",
    },
    messageEntry("recent", "branch-summary", "Recent branch context"),
  ];

  const resolved = buildSessionContext(entries, "recent");
  assert.deepEqual(
    resolved.messages.map((message) => message.role),
    ["user", "branchSummary", "user"],
  );

  const transfer = buildTransferContext(contextSession(entries, "recent"));
  assert.match(transfer.text, /Branch summary:\nBRANCH-SUMMARY-MARKER/);
  assert.match(transfer.text, /Recent branch context/);
});

function contextSession(
  entries: SessionEntry[],
  leafId: string,
): Pick<SessionManager, "getEntries" | "getLeafId"> {
  return {
    getEntries: () => entries,
    getLeafId: () => leafId,
  };
}

function messageEntry(
  id: string,
  parentId: string | null,
  text: string,
): SessionEntry {
  return agentMessageEntry(id, parentId, {
    role: "user",
    content: text,
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  });
}

function agentMessageEntry(
  id: string,
  parentId: string | null,
  message: SessionMessage,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}
