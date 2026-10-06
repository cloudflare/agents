import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord, MessageChange } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  PiChunkProjection,
  toToolOutputChunk,
  toTranscriptMessages
} from "../projections/pi";
import type { ResponseChunk } from "../protocol";
import { responseWriter } from "../response";

/** Append every chunk to a response, which throws on a grammar error. */
function record(chunks: readonly ResponseChunk[]): ResponseChunk[] {
  const recorded: ResponseChunk[] = [];
  const response = responseWriter({
    streamId: "response",
    cursor: 0,
    append: (chunk) => recorded.push(chunk as unknown as ResponseChunk),
    close: () => {},
    error: () => {}
  });
  for (const chunk of chunks) response.append(chunk);
  response.end();
  return recorded;
}

function entry(id: number, kind: string, message?: object): EntryRecord {
  // SAFETY: test fixtures carry only the fields the projection reads.
  return {
    id,
    conversationId: 1,
    kind,
    ...(message && { model: [{ timestamp: 0, ...message }] })
  } as unknown as EntryRecord;
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  // SAFETY: as above.
  return { role: "assistant", content, timestamp: 0 } as AssistantMessage;
}

const toolCall = {
  type: "toolCall",
  id: "c",
  name: "current_time",
  arguments: {}
} as const;

describe("pi projection", () => {
  it("projects entries into transcript messages", () => {
    const messages = toTranscriptMessages([
      entry(1, "pi.system", { role: "system", content: "Be brief" }),
      entry(2, "pi.message", {
        role: "user",
        content: [
          { type: "text", text: "What time is it?" },
          { type: "image", mimeType: "image/png", data: "AAAA" }
        ]
      }),
      entry(3, "pi.message", {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Use the tool" }, toolCall],
        errorMessage: "rate limited"
      }),
      entry(4, "pi.message", {
        role: "toolResult",
        toolCallId: "c",
        toolName: "current_time",
        content: [{ type: "text", text: "noon" }],
        details: { iso: "12:00" },
        isError: false
      }),
      entry(5, "pi.reset"),
      entry(6, "pi.message", { role: "user", content: "Again" })
    ]);
    expect(messages).toEqual([
      {
        id: "2",
        role: "user",
        parts: [
          { type: "text", text: "What time is it?" },
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64,AAAA"
          }
        ]
      },
      {
        id: "3",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Use the tool" },
          {
            type: "tool",
            toolCallId: "c",
            toolName: "current_time",
            state: "output-available",
            input: {},
            output: { iso: "12:00" }
          },
          { type: "text", text: "Error: rate limited" }
        ]
      },
      {
        id: "5",
        role: "system",
        parts: [{ type: "text", text: "Context reset" }]
      },
      { id: "6", role: "user", parts: [{ type: "text", text: "Again" }] }
    ]);
  });

  it("projects a run's live messages into grammatical response chunks", () => {
    const run = new PiChunkProjection();
    const text = { type: "text", text: "" } as const;
    const changes: MessageChange[] = [
      {
        type: "thinking_start",
        contentIndex: 0,
        block: { type: "thinking", thinking: "" }
      },
      { type: "thinking_delta", contentIndex: 0, delta: "Use the tool" },
      {
        type: "block",
        contentIndex: 0,
        block: { type: "thinking", thinking: "Use the tool" }
      },
      { type: "text_start", contentIndex: 1, block: text },
      { type: "text_delta", contentIndex: 1, delta: "Checking" },
      { type: "block", contentIndex: 2, block: toolCall }
    ];
    const output = toToolOutputChunk("c", {
      role: "toolResult",
      toolCallId: "c",
      toolName: "current_time",
      content: [{ type: "text", text: "boom" }],
      isError: true,
      timestamp: 0
    } as Message);
    run.startMessage();
    const chunks = [
      ...run.changes(changes),
      ...run.endMessage(assistant([text, toolCall])),
      ...(output ? [output] : [])
    ];
    run.startMessage();
    chunks.push(
      ...run.changes([
        {
          type: "text_start",
          contentIndex: 0,
          block: { type: "text", text: "It is noon" }
        }
      ]),
      ...run.end()
    );
    expect(record(chunks)).toEqual([
      { type: "reasoning-start", id: "1:0" },
      { type: "reasoning-delta", id: "1:0", delta: "Use the tool" },
      { type: "reasoning-end", id: "1:0" },
      { type: "text-start", id: "1:1" },
      { type: "text-delta", id: "1:1", delta: "Checking" },
      { type: "tool-input-start", toolCallId: "c", toolName: "current_time" },
      {
        type: "tool-input-available",
        toolCallId: "c",
        toolName: "current_time",
        input: {}
      },
      { type: "text-end", id: "1:1" },
      { type: "tool-output-error", toolCallId: "c", errorText: "boom" },
      { type: "text-start", id: "2:0" },
      { type: "text-delta", id: "2:0", delta: "It is noon" },
      { type: "text-end", id: "2:0" }
    ]);
  });

  it("resumes a message in progress so later deltas continue it", () => {
    const run = new PiChunkProjection();
    run.startMessage();
    const chunks = [
      ...run.resume(assistant([{ type: "text", text: "Half" }, toolCall])),
      ...run.changes([{ type: "text_delta", contentIndex: 0, delta: " done" }]),
      ...run.endMessage(
        assistant([{ type: "text", text: "Half done" }, toolCall])
      )
    ];
    expect(record(chunks).map((chunk) => chunk.type)).toEqual([
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-available"
    ]);
  });
});
