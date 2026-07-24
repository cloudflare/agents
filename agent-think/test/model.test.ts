import { describe, expect, it, vi } from "vitest";
import { createAgentThinkModel } from "../src/model";

const completion = {
  id: "resp-test",
  created_at: 1,
  model: "gpt-5.6-sol",
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

const streamEvents = [
  {
    type: "response.created",
    response: {
      id: "resp-stream",
      created_at: 1,
      model: "gpt-5.6-sol",
      service_tier: null
    }
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg-stream", phase: null }
  },
  {
    type: "response.output_text.delta",
    item_id: "msg-stream",
    delta: "streamed",
    logprobs: null
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", id: "msg-stream", phase: null }
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

const anthropicCompletion = {
  id: "msg-test",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [{ type: "text", text: "fallback" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 }
};

describe("createAgentThinkModel", () => {
  it("uses the team Gateway token and project attribution", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(completion)
    );
    const model = createAgentThinkModel("team-token", fetch);

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0];
    expect(String(input)).toBe(
      "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/openai/responses"
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBe("Bearer team-token");
    expect(headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ project: "agents-team-agent-think" })
    );
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "max" },
      store: false,
      include: ["reasoning.encrypted_content"]
    });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("streams through the Responses API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          streamEvents
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        )
    );
    const model = createAgentThinkModel("team-token", fetch);

    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    });
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "msg-stream",
      delta: "streamed"
    });
    const [input, init] = fetch.mock.calls[0];
    expect(String(input)).toContain("/openai/responses");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "max" },
      store: false,
      stream: true
    });
  });

  it("falls back from a failed GPT request to Opus 4.8", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).includes("/openai/")) {
        return Response.json(
          { error: { message: "Payment Required", type: "gateway_error" } },
          { status: 402 }
        );
      }
      return Response.json(anthropicCompletion);
    });
    const model = createAgentThinkModel("team-token", fetch);

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/openai/responses",
      "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/anthropic/messages"
    ]);
    const fallbackInit = fetch.mock.calls[1][1];
    const fallbackHeaders = new Headers(fallbackInit?.headers);
    expect(fallbackHeaders.get("authorization")).toBeNull();
    expect(fallbackHeaders.get("x-api-key")).toBeNull();
    expect(fallbackHeaders.get("cf-aig-authorization")).toBe(
      "Bearer team-token"
    );
    expect(fallbackHeaders.get("cf-aig-metadata")).toBe(
      JSON.stringify({ project: "agents-team-agent-think" })
    );
    expect(JSON.parse(String(fallbackInit?.body))).toMatchObject({
      model: "claude-opus-4-8",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" }
    });
    expect(result.content).toContainEqual({ type: "text", text: "fallback" });
  });

  it.each([undefined, "", "   "])(
    "fails closed when the team token is unavailable (%s)",
    (token) => {
      expect(() => createAgentThinkModel(token, vi.fn())).toThrow(
        "CLOUDFLARE_AIG_TOKEN is not configured"
      );
    }
  );
});
