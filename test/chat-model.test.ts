import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatModel, toModelInfo, toUsageStats } from "../src/chat/chat-model";
import type { HostMessage } from "../src/shared/protocol";

function collect(): { messages: HostMessage[]; model: ChatModel } {
  const messages: HostMessage[] = [];
  const model = new ChatModel({ emit: (message) => messages.push(message) });
  return { messages, model };
}

test("streams assistant text and thinking into one item", () => {
  const { model } = collect();
  model.applyEvent({ type: "agent_start" });
  assert.equal(model.meta.isStreaming, true);

  model.applyEvent({ type: "message_start", message: { role: "assistant" } });
  model.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "let me " },
  });
  model.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hello " },
  });
  model.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "world" },
  });

  assert.equal(model.items.length, 1);
  const item = model.items[0];
  assert.equal(item?.kind, "assistant");
  if (item?.kind === "assistant") {
    assert.equal(item.text, "Hello world");
    assert.equal(item.thinking, "let me ");
    assert.equal(item.streaming, true);
  }

  model.applyEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "Hello world!" },
      ],
      stopReason: "stop",
    },
  });
  const settled = model.items[0];
  if (settled?.kind === "assistant") {
    assert.equal(settled.text, "Hello world!");
    assert.equal(settled.thinking, "let me think");
    assert.equal(settled.streaming, false);
  }
});

test("tracks tool calls from start to end with a diff", () => {
  const { model } = collect();
  model.applyEvent({ type: "agent_start" });
  model.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", id: "call_1", toolName: "edit" },
  });
  model.applyEvent({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", delta: '{"path":"a.ts",' },
  });
  model.applyEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      toolCall: { id: "call_1", name: "edit", arguments: { path: "a.ts", oldText: "a", newText: "b" } },
    },
  });
  const running = model.items.find((item) => item.kind === "tool");
  assert.equal(running?.kind, "tool");
  if (running?.kind === "tool") {
    assert.equal(running.status, "running");
    assert.equal(running.args.path, "a.ts");
  }

  model.applyEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "edit",
    isError: false,
    result: {
      content: [{ type: "text", text: "Edited a.ts" }],
      details: { diff: "@@ -1 +1 @@\n-a\n+b" },
    },
  });
  const done = model.items.find((item) => item.kind === "tool");
  if (done?.kind === "tool") {
    assert.equal(done.status, "ok");
    assert.equal(done.output, "Edited a.ts");
    assert.match(done.diff ?? "", /\+b/);
    assert.equal(done.filePath, "a.ts");
  }
});

test("does not duplicate the optimistically rendered user message", () => {
  const { model } = collect();
  model.addUserMessage("fix the bug", []);
  assert.equal(model.items.length, 1);

  model.applyEvent({ type: "message_start", message: { role: "user", content: "fix the bug" } });
  model.applyEvent({ type: "message_end", message: { role: "user", content: "fix the bug" } });
  assert.equal(model.items.length, 1);

  // A user message we did not render still shows up.
  model.applyEvent({ type: "message_start", message: { role: "user", content: "from another client" } });
  assert.equal(model.items.length, 2);
});

test("rebuilds history and attaches fork entry ids", () => {
  const { model } = collect();
  model.setHistory(
    [
      { role: "user", content: "first", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "x.ts" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "second", timestamp: 4 },
    ],
    [
      { entryId: "e1", text: "first" },
      { entryId: "e2", text: "second" },
    ],
  );

  assert.equal(model.items.length, 4);
  const users = model.items.filter((item) => item.kind === "user");
  assert.deepEqual(
    users.map((item) => (item.kind === "user" ? item.entryId : undefined)),
    ["e1", "e2"],
  );
  const tool = model.items.find((item) => item.kind === "tool");
  if (tool?.kind === "tool") {
    assert.equal(tool.status, "ok");
    assert.equal(tool.output, "file body");
  }
});

test("maps session stats and model info", () => {
  const stats = toUsageStats({
    tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, total: 125 },
    cost: 0.5,
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
  });
  assert.equal(stats?.totalTokens, 125);
  assert.equal(stats?.cost, 0.5);
  assert.equal(stats?.contextPercent, 0.5);

  const model = toModelInfo({
    id: "gpt-x",
    name: "GPT X",
    provider: "openai",
    reasoning: true,
    contextWindow: 128000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  });
  assert.equal(model?.id, "gpt-x");
  assert.equal(model?.reasoning, true);
  assert.equal(toModelInfo({ id: "no-provider" }), null);
});

test("surfaces retry and compaction notes", () => {
  const { model } = collect();
  model.applyEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "overloaded" });
  assert.equal(model.items.at(-1)?.kind, "note");

  model.applyEvent({ type: "compaction_start", reason: "threshold" });
  assert.equal(model.meta.isCompacting, true);
  model.applyEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    result: { summary: "summary text", tokensBefore: 1000, estimatedTokensAfter: 200 },
  });
  assert.equal(model.meta.isCompacting, false);
  const compaction = model.items.find((item) => item.kind === "compaction");
  if (compaction?.kind === "compaction") {
    assert.equal(compaction.text, "summary text");
    assert.equal(compaction.tokensAfter, 200);
  }
});

test("merges live streaming usage into the session snapshot", () => {
  const { model } = collect();
  model.setStats(
    toUsageStats({
      tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, total: 160 },
      cost: 0.5,
      contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
    }),
  );

  model.applyEvent({ type: "agent_start" });
  model.applyEvent({ type: "message_start", message: { role: "assistant" } });
  model.applyEvent({
    type: "message_update",
    usage: { input: 2000, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: 3010, cost: { total: 0.01 } },
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });

  // Snapshot plus the in-flight message, with context tracked live.
  assert.equal(model.meta.stats?.input, 2100);
  assert.equal(model.meta.stats?.output, 30);
  assert.equal(model.meta.stats?.cacheRead, 1040);
  assert.equal(model.meta.stats?.totalTokens, 3170);
  assert.equal(model.meta.stats?.live, true);
  assert.equal(model.meta.stats?.contextTokens, 3000);
  assert.equal(model.meta.stats?.contextPercent, 1.5);

  // `message_end` commits the message; a fresh snapshot then replaces it.
  model.applyEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: { input: 2000, output: 12, cacheRead: 1000, cacheWrite: 0, totalTokens: 3012, cost: { total: 0.02 } },
    },
  });
  assert.equal(model.meta.stats?.output, 32);
  assert.equal(model.meta.stats?.totalTokens, 3172);
  assert.equal(model.meta.stats?.live, true);

  model.setStats(
    toUsageStats({
      tokens: { input: 2100, output: 32, cacheRead: 1040, cacheWrite: 0, total: 3172 },
      cost: 0.52,
      contextUsage: { tokens: 3000, contextWindow: 200000, percent: 1.5 },
    }),
  );
  assert.equal(model.meta.stats?.totalTokens, 3172);
  assert.equal(model.meta.stats?.live, undefined);

  // A second assistant message in the same turn (tool loop) keeps the context
  // estimate pinned to the newest prompt instead of summing both prompts.
  model.applyEvent({ type: "message_start", message: { role: "assistant" } });
  model.applyEvent({
    type: "message_update",
    usage: { input: 4000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 4005, cost: { total: 0 } },
    assistantMessageEvent: { type: "text_delta", delta: "there" },
  });
  assert.equal(model.meta.stats?.contextTokens, 4000);
  assert.equal(model.meta.stats?.contextPercent, 2);
  assert.equal(model.meta.stats?.input, 6100);

  // A new session clears the counters entirely.
  model.reset();
  assert.equal(model.meta.stats, null);
});
