import { describe, expect, it, vi } from "vitest";
import { createAgentThinkModel } from "../src/model";

const completion = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "gpt-5.5",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop"
    }
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};

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
      "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/openai/chat/completions"
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBe("Bearer team-token");
    expect(headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ project: "agents-team-agent-think" })
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.5",
      reasoning_effort: "medium"
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
      "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/openai/chat/completions",
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
