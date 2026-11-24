import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { sanitizeMessage } from "../../sessions/sanitize";

/**
 * What a Sessions write keeps of OpenAI's provider metadata. Item ids are
 * stripped (#728: a replayed reasoning id reached the provider twice),
 * except a reasoning item that a provider-executed tool call in the same
 * message depends on (#2639).
 */

/** An assistant message as the AI SDK streams a `web_search` turn. */
function webSearchTurn(reasoningText: string): SessionMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "reasoning",
        text: reasoningText,
        state: "done",
        providerMetadata: {
          openai: { itemId: "rs_123", reasoningEncryptedContent: null }
        }
      },
      {
        type: "tool-web_search",
        toolCallId: "ws_456",
        state: "output-available",
        input: {},
        output: { sources: [] },
        providerExecuted: true
      },
      {
        type: "text",
        text: "answer",
        providerMetadata: { openai: { itemId: "msg_789" } }
      }
    ]
  } as SessionMessage;
}

type Part = {
  type: string;
  providerMetadata?: { openai?: Record<string, unknown> };
};

describe("sanitizeMessage", () => {
  it("keeps the reasoning item a provider-executed tool call needs (#2639)", () => {
    const parts = sanitizeMessage(webSearchTurn("")).parts as Part[];
    expect(parts.map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "tool-web_search",
      "text"
    ]);
    expect(parts[1].providerMetadata?.openai).toEqual({ itemId: "rs_123" });
    // Other ids are still stripped.
    expect(parts[3].providerMetadata).toBeUndefined();
  });

  it("keeps it when the reasoning has summary text too", () => {
    const parts = sanitizeMessage(webSearchTurn("thinking")).parts as Part[];
    expect(parts[1]).toMatchObject({
      type: "reasoning",
      text: "thinking",
      providerMetadata: { openai: { itemId: "rs_123" } }
    });
  });

  it("strips reasoning ids and drops an emptied reasoning part without a provider-executed tool (#728)", () => {
    const message = {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "",
          providerMetadata: { openai: { itemId: "rs_999" } }
        },
        {
          type: "tool-lookup",
          toolCallId: "call_1",
          state: "output-available",
          input: {},
          output: {}
        },
        { type: "text", text: "done" }
      ]
    } as SessionMessage;
    expect(
      (sanitizeMessage(message).parts as Part[]).map((part) => part.type)
    ).toEqual(["tool-lookup", "text"]);
  });

  it("stores and reads back the reasoning item of a web_search turn", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(webSearchTurn(""));
      const [stored] = await session.getHistory();
      expect((stored.parts as Part[])[1]).toMatchObject({
        type: "reasoning",
        providerMetadata: { openai: { itemId: "rs_123" } }
      });
    });
  });
});
