/**
 * The core transport over the AI binding: `env.AI.run` for model ids, and the
 * binding's own `fetch` for the provider-native path.
 */
import { describe, expect, it } from "vitest";
import { CloudflareAIError } from "../../../models/core/errors";
import type { ResolvedGateway } from "../../../models/core/settings";
import {
  createTransport,
  errorFromGatewayEnvelope,
  isGatewayErrorEnvelope,
  type NativeRequest,
  unwrapEnvelope
} from "../../../models/core/transport";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface RunCall {
  model: string;
  input: unknown;
  options: Record<string, unknown>;
}

/** An `Ai`-shaped binding that records `fetch` and `run`. */
function fakeBinding(response: () => Response) {
  const fetches: FetchCall[] = [];
  const runs: RunCall[] = [];
  const binding = {
    aiGatewayLogId: null,
    async fetch(url: string, init?: RequestInit) {
      fetches.push({ init, url });
      return response();
    },
    async run(model: string, input: unknown, options: Record<string, unknown>) {
      runs.push({ input, model, options });
      return response();
    }
  };
  return { binding: binding as unknown as Ai, fetches, runs };
}

const GATEWAY: ResolvedGateway = { id: "prod" };

function nativeRequest(overrides: Partial<NativeRequest> = {}): NativeRequest {
  return {
    body: JSON.stringify({ max_tokens: 8, model: "claude-opus-4-8" }),
    endpoint: "v1/messages",
    gateway: GATEWAY,
    headers: { "anthropic-version": "2023-06-01" },
    method: "POST",
    provider: "anthropic",
    ...overrides
  };
}

const VENDOR_BODY = JSON.stringify({
  content: [{ text: "Hi there! How can I", type: "text" }],
  id: "msg_011CegnMKWL1HKYVLHSn8shv",
  model: "claude-opus-4-8",
  role: "assistant",
  type: "message"
});

describe("core transport - provider-native requests over the binding", () => {
  it("sends the vendor's request to the gateway's provider route, options as headers", async () => {
    const { binding, fetches } = fakeBinding(
      () => new Response(VENDOR_BODY, { status: 200 })
    );
    const response = await createTransport({ binding }).native(
      nativeRequest({
        gateway: {
          byokAlias: "team-a",
          cacheTtl: 60,
          collectLog: true,
          eventId: "evt-1",
          id: "prod",
          metadata: { tenant: "acme" },
          requestTimeoutMs: 9000,
          retries: { backoff: "linear", maxAttempts: 2 },
          skipCache: false,
          zdr: true
        }
      })
    );

    expect(response.status).toBe(200);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe(
      "https://workers-binding.ai/ai-gateway/gateways/prod/anthropic/v1/messages"
    );
    expect(fetches[0]?.init?.method).toBe("POST");
    expect(fetches[0]?.init?.body).toBe(
      JSON.stringify({ max_tokens: 8, model: "claude-opus-4-8" })
    );
    expect(fetches[0]?.init?.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "cf-aig-backoff": "linear",
      "cf-aig-byok-alias": "team-a",
      "cf-aig-cache-ttl": "60",
      "cf-aig-collect-log": "true",
      "cf-aig-event-id": "evt-1",
      "cf-aig-max-attempts": "2",
      "cf-aig-metadata": '{"tenant":"acme"}',
      "cf-aig-request-timeout": "9000",
      "cf-aig-skip-cache": "false",
      "cf-aig-zdr": "true"
    });
  });

  it("returns the vendor's own error response untouched", async () => {
    const { binding } = fakeBinding(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "model: claude-opus-4.8 was not found." },
            type: "error"
          }),
          { status: 404 }
        )
    );
    const response = await createTransport({ binding }).native(nativeRequest());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ type: "error" });
  });

  it("normalizes a thrown binding failure into a CloudflareAIError", async () => {
    const binding = {
      fetch() {
        throw new Error("3040: Capacity temporarily exceeded");
      }
    } as unknown as Ai;
    await expect(
      createTransport({ binding }).native(nativeRequest())
    ).rejects.toMatchObject({
      isRetryable: true,
      name: "CloudflareAIError",
      status: 429
    });
  });
});

describe("core transport - the run path", () => {
  it("names the answer format for a catalog model, in the format asked for", async () => {
    const { binding, runs } = fakeBinding(() => new Response("{}"));
    const transport = createTransport({ binding });
    for (const format of [
      "chat-completions",
      "messages",
      "responses"
    ] as const) {
      await transport.run({
        format,
        gateway: GATEWAY,
        headers: {},
        input: {},
        model: "anthropic/claude-opus-4.8"
      });
    }
    expect(runs.map((run) => run.options.openaiEndpoint)).toEqual([
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses"
    ]);
  });

  it("sends byokAlias as a header for a catalog model, and zdr not at all", async () => {
    const { binding, runs } = fakeBinding(() => new Response("{}"));
    await createTransport({ binding }).run({
      gateway: { byokAlias: "team-a", id: "prod", zdr: true },
      headers: {},
      input: {},
      model: "anthropic/claude-opus-4.8"
    });
    expect(runs[0]?.options.extraHeaders).toEqual({
      "cf-aig-byok-alias": "team-a"
    });
    expect(runs[0]?.options.gateway).toEqual({ id: "prod" });
  });

  it("leaves a Workers AI request to Workers AI", async () => {
    const { binding, runs } = fakeBinding(() => new Response("{}"));
    await createTransport({ binding }).run({
      gateway: { byokAlias: "team-a", id: "prod" },
      headers: {},
      input: {},
      model: "@cf/zai-org/glm-4.7-flash"
    });
    expect(runs[0]?.options).not.toHaveProperty("openaiEndpoint");
    expect(runs[0]?.options).not.toHaveProperty("extraHeaders");
  });
});

describe("core transport - settings", () => {
  it("requires the AI binding: there is no HTTP transport", () => {
    expect(() => createTransport({} as never)).toThrow(
      /requires \{ binding \}/
    );
  });
});

describe("core transport - gateway error envelopes", () => {
  it("recognises the gateway's own envelope and nothing else", () => {
    expect(
      isGatewayErrorEnvelope({
        error: [{ code: 2001, message: "This AI gateway does not exist" }],
        name: "AiGatewayError",
        success: false
      })
    ).toBe(true);
    expect(
      isGatewayErrorEnvelope({
        error: [{ code: 2005, message: "insufficient balance" }],
        success: false
      })
    ).toBe(true);
    // A vendor's own error is not ours to interpret.
    expect(
      isGatewayErrorEnvelope({
        error: { message: "model not found", type: "not_found_error" },
        type: "error"
      })
    ).toBe(false);
    expect(isGatewayErrorEnvelope({ content: [], type: "message" })).toBe(
      false
    );
    expect(isGatewayErrorEnvelope("boom")).toBe(false);
    expect(isGatewayErrorEnvelope(null)).toBe(false);
  });

  it("turns the envelope into a classified CloudflareAIError", () => {
    const body = {
      error: [{ code: 2005, message: "insufficient balance" }],
      name: "AiGatewayError",
      success: false
    };
    const error = errorFromGatewayEnvelope(body, {
      model: "claude-opus-4-8",
      requestBodyValues: { model: "claude-opus-4-8" },
      responseHeaders: { "cf-aig-log-id": "01M1" },
      status: 402,
      url: "ai-gateway-binding"
    });
    expect(error).toBeInstanceOf(CloudflareAIError);
    expect(error.message).toBe("insufficient balance");
    expect(error.code).toBe("gateway-error");
    expect(error.logId).toBe("01M1");
    expect(error.isRetryable).toBe(false);
    expect(
      errorFromGatewayEnvelope(
        { error: [{ code: 2001, message: "no gateway" }], success: false },
        { model: "m", requestBodyValues: undefined, status: 404, url: "u" }
      ).code
    ).toBe("not-found");
  });
});

describe("core transport - run-path envelopes", () => {
  const context = { model: "@cf/zai-org/glm-4.7-flash", status: 200, url: "u" };

  it("unwraps a successful envelope and leaves a bare payload alone", () => {
    expect(
      unwrapEnvelope({ result: { a: 1 }, success: true }, context)
    ).toEqual({
      a: 1
    });
    expect(unwrapEnvelope({ choices: [] }, context)).toEqual({ choices: [] });
  });

  it("raises a 2xx failure envelope that carries no result", () => {
    expect(() =>
      unwrapEnvelope(
        { error: [{ code: 2001, message: "no gateway" }], success: false },
        context
      )
    ).toThrow(CloudflareAIError);
    expect(() =>
      unwrapEnvelope(
        { error: [{ code: 2001, message: "no gateway" }], success: false },
        context
      )
    ).toThrow("no gateway");
  });

  it("leaves a payload whose own `success` field is false", () => {
    expect(unwrapEnvelope({ success: false, answer: "no" }, context)).toEqual({
      answer: "no",
      success: false
    });
  });
});
