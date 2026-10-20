/**
 * `createAI({ accountId, apiToken })`: the same two routes as the binding,
 * over HTTP. A model id goes to the REST API, a model object to the
 * provider-native path on `gateway.ai.cloudflare.com`.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAI } from "../../../models/ai-sdk";
import { callOptions, collect, jsonResponse, sseResponse } from "./helpers";
import { headersOf, stubFetch } from "../fetch-stub";

const ACCOUNT = { accountId: "acct-1", apiToken: "token-1" } as const;

function chatBody(text: string) {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: text, role: "assistant" }
      }
    ],
    created: 0,
    id: "chatcmpl-rest",
    model: "gpt-5.5",
    object: "chat.completion",
    usage: { completion_tokens: 5, prompt_tokens: 3, total_tokens: 8 }
  };
}

describe("ai-sdk createAI over HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a catalog id on the REST API, on the default gateway", async () => {
    const calls = stubFetch(() => jsonResponse(chatBody("Hi there")));
    const ai = createAI(ACCOUNT);
    const result = await ai("openai/gpt-5.5").doGenerate(callOptions());

    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions"
    );
    const headers = headersOf(calls[0]);
    expect(headers.authorization).toBe("Bearer token-1");
    expect(headers["cf-aig-gateway-id"]).toBe("default");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "openai/gpt-5.5"
    });
    expect(result.content).toEqual([{ text: "Hi there", type: "text" }]);
  });

  it("streams a catalog id", async () => {
    const chunk = (delta: Record<string, unknown>, finish?: string) =>
      JSON.stringify({
        choices: [
          { delta, index: 0, ...(finish ? { finish_reason: finish } : {}) }
        ],
        id: "chatcmpl-rest",
        object: "chat.completion.chunk"
      });
    stubFetch(() =>
      sseResponse([chunk({ content: "Hi" }), chunk({}, "stop"), "[DONE]"])
    );
    const ai = createAI({ ...ACCOUNT, gateway: "project-gateway" });
    const { stream } = await ai("openai/gpt-5.5").doStream(callOptions());
    const parts = await collect(stream);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
    ).toEqual(["Hi"]);
  });

  it("sends a model object to the provider-native path with the token", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        content: [{ text: "Hi", type: "text" }],
        id: "msg_1",
        model: "claude-opus-4-8",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 3, output_tokens: 1 }
      })
    );
    const ai = createAI({ ...ACCOUNT, gateway: "project-gateway" });
    const anthropic = createAnthropic({ apiKey: "cloudflare" });
    const result = await ai(anthropic("claude-opus-4-8")).doGenerate(
      callOptions()
    );

    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-1/project-gateway/anthropic/v1/messages"
    );
    const headers = headersOf(calls[0]);
    expect(headers["cf-aig-authorization"]).toBe("Bearer token-1");
    expect(headers).not.toHaveProperty("x-api-key");
    expect(result.content).toEqual([{ text: "Hi", type: "text" }]);
  });
});
