import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  createExoGatewayOpenAIModel,
  parseModelSpec,
  publicModelError
} from "../kernel/model";

const completion = {
  id: "resp-test",
  created_at: 1,
  model: "gpt-5.6-terra",
  output: [
    {
      type: "message",
      id: "msg-test",
      role: "assistant",
      content: [
        { type: "output_text", text: "ok", annotations: [], logprobs: null }
      ]
    }
  ],
  incomplete_details: null,
  usage: {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 1 }
  }
};

const toolCallStreamEvents = [
  {
    type: "response.created",
    response: {
      id: "resp-stream",
      created_at: 1,
      model: "gpt-5.6-terra",
      service_tier: null
    }
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "function_call",
      id: "fc-echo",
      call_id: "call-echo",
      name: "echo",
      arguments: "",
      namespace: null
    }
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: "fc-echo",
    output_index: 0,
    delta: '{"message":"hi"}'
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      id: "fc-echo",
      call_id: "call-echo",
      name: "echo",
      arguments: '{"message":"hi"}',
      status: "completed",
      namespace: null
    }
  },
  {
    type: "response.completed",
    response: {
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 1 }
      },
      service_tier: null
    }
  }
];

const prompt = [
  { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }
];

describe("parseModelSpec", () => {
  it("accepts supported offline, Workers AI, and OpenAI models", () => {
    expect(parseModelSpec("mock")).toEqual({ kind: "mock" });
    expect(parseModelSpec("workers-ai:@cf/moonshotai/kimi-k2.7-code")).toEqual({
      kind: "workers-ai",
      id: "@cf/moonshotai/kimi-k2.7-code"
    });
    expect(parseModelSpec("@cf/moonshotai/kimi-k2.7-code")).toEqual({
      kind: "workers-ai",
      id: "@cf/moonshotai/kimi-k2.7-code"
    });
    expect(parseModelSpec("openai/gpt-5.6-terra")).toEqual({
      kind: "openai",
      id: "gpt-5.6-terra"
    });
    expect(parseModelSpec("openai:gpt-5.6-terra")).toEqual({
      kind: "openai",
      id: "gpt-5.6-terra"
    });
  });

  it("rejects empty, malformed, and unsupported provider specs", () => {
    expect(() => parseModelSpec("")).toThrow(/empty/);
    expect(() => parseModelSpec("workers-ai:")).toThrow(/empty/);
    expect(() => parseModelSpec("openai/")).toThrow(/empty/);
    expect(() => parseModelSpec("gpt-5.6-terra")).toThrow(/Unknown model/);
    expect(() => parseModelSpec("anthropic/claude-sonnet-4-5")).toThrow(
      'Unsupported model provider "anthropic"'
    );
  });
});

describe("createExoGatewayOpenAIModel", () => {
  it("routes Terra through the managed gateway with team authentication and attribution", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(completion)
    );
    const model = createExoGatewayOpenAIModel(
      "gpt-5.6-terra",
      "team-token",
      fetch
    );

    await model.doGenerate({
      prompt,
      headers: {
        authorization: "Bearer placeholder-provider-token",
        "x-api-key": "placeholder-provider-key"
      }
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0];
    expect(String(input)).toBe(
      "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/openai/v1/responses"
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBe("Bearer team-token");
    expect(headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ project: "agents-team-exo-harness" })
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.6-terra"
    });
  });

  it("preserves streaming, abort signals, and tool calls", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          toolCallStreamEvents
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        )
    );
    const controller = new AbortController();
    const model = createExoGatewayOpenAIModel(
      "gpt-5.6-terra",
      "team-token",
      fetch
    );

    const result = await model.doStream({
      prompt,
      abortSignal: controller.signal,
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Echo a message",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"]
          }
        }
      ]
    });
    const chunks: unknown[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.6-terra",
      stream: true,
      tools: [
        {
          type: "function",
          name: "echo"
        }
      ]
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "call-echo",
        toolName: "echo",
        input: '{"message":"hi"}'
      })
    );
  });

  it("sends encrypted reasoning instead of persisted item references for ZDR continuations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(completion)
    );
    const model = createExoGatewayOpenAIModel(
      "gpt-5.6-terra",
      "team-token",
      fetch
    );
    const continuationPrompt: LanguageModelV4Prompt = [
      ...prompt,
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              openai: {
                itemId: "rs-test",
                reasoningEncryptedContent: "encrypted-reasoning"
              }
            }
          },
          {
            type: "tool-call",
            toolCallId: "call-echo",
            toolName: "echo",
            input: '{"message":"hi"}',
            providerOptions: { openai: { itemId: "fc-echo" } }
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-echo",
            toolName: "echo",
            output: { type: "json", value: { echoed: "hi" } }
          }
        ]
      }
    ];

    await model.doGenerate({ prompt: continuationPrompt });

    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      store?: unknown;
      input?: unknown;
    };
    expect(body.store).toBe(false);
    expect(JSON.stringify(body.input)).not.toContain("item_reference");
    expect(body.input).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "encrypted-reasoning"
      })
    );
  });

  it.each([undefined, "", "   "])(
    "fails closed when the team gateway token is unavailable (%s)",
    (token) => {
      expect(() =>
        createExoGatewayOpenAIModel("gpt-5.6-terra", token, vi.fn())
      ).toThrow("CLOUDFLARE_AIG_TOKEN is not configured");
    }
  );

  it("keeps gateway failures client-safe", async () => {
    const token = "secret-team-token";
    const model = createExoGatewayOpenAIModel(
      "gpt-5.6-terra",
      token,
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          { error: { message: "Gateway unavailable", type: "gateway_error" } },
          { status: 503 }
        )
      )
    );

    let message = "";
    try {
      await model.doGenerate({ prompt });
    } catch (error) {
      message = publicModelError(error);
    }

    expect(message).toContain("Gateway unavailable");
    expect(message).not.toContain(token);
    expect(message).not.toContain("\n");
  });
});

describe("publicModelError", () => {
  it("returns a bounded one-line message without a stack", () => {
    expect(publicModelError(new Error("Invalid input\n    at foo"))).toBe(
      "Invalid input"
    );
    expect(publicModelError("plain")).toBe("plain");
  });
});
