/**
 * The core transport over the AI binding (`env.AI.run` for model ids, the
 * binding's own `fetch` for the provider-native path) and over HTTP with an
 * account id and API token (the REST API and `gateway.ai.cloudflare.com`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareAIError } from "../../../models/core/errors";
import type { ResolvedGateway } from "../../../models/core/settings";
import {
  createTransport,
  errorFromGatewayEnvelope,
  isGatewayErrorEnvelope,
  type NativeRequest,
  unwrapEnvelope
} from "../../../models/core/transport";
import { headersOf, stubFetch } from "../fetch-stub";

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

  it("sends a raw audio body as a stream, without a gateway", async () => {
    const { binding, runs } = fakeBinding(() => new Response("{}"));
    await createTransport({ binding }).run({
      audio: { bytes: new Uint8Array([0, 1, 2]), contentType: "audio/mpeg" },
      gateway: { cacheTtl: 60, id: "prod" },
      headers: {},
      input: { language: "en" },
      model: "@cf/deepgram/nova-3"
    });
    const input = runs[0]?.input as {
      audio: { body: ReadableStream; contentType: string };
      language: string;
    };
    expect(input.language).toBe("en");
    expect(input.audio.contentType).toBe("audio/mpeg");
    expect(
      new Uint8Array(await new Response(input.audio.body).arrayBuffer())
    ).toEqual(new Uint8Array([0, 1, 2]));
    expect(runs[0]?.options).not.toHaveProperty("gateway");
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
  it("requires the AI binding or an account id and API token", () => {
    expect(() => createTransport({} as never)).toThrow(
      /requires \{ binding \} \(the AI binding\) or \{ accountId, apiToken \}/
    );
    expect(() =>
      createTransport({ accountId: "acct", apiToken: "" } as never)
    ).toThrow(/requires/);
  });
});

const ACCOUNT = { accountId: "acct-1", apiToken: "token-1" };

describe("core transport - the run path over HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a catalog model to the REST API endpoint for its format, the model in the body", async () => {
    const calls = stubFetch(() => new Response("{}"));
    const transport = createTransport(ACCOUNT);
    for (const format of [
      "chat-completions",
      "messages",
      "responses"
    ] as const) {
      await transport.run({
        format,
        gateway: GATEWAY,
        headers: {},
        input: { max_tokens: 8, stream: true },
        model: "anthropic/claude-opus-4.8"
      });
    }
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions",
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/messages",
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/responses"
    ]);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      max_tokens: 8,
      model: "anthropic/claude-opus-4.8",
      stream: true
    });
  });

  it("authenticates with the token and sends the gateway options as cf-aig-* headers", async () => {
    const calls = stubFetch(() => new Response("{}"));
    await createTransport(ACCOUNT).run({
      gateway: {
        byokAlias: "team-a",
        cacheTtl: 60,
        id: "prod",
        metadata: { tenant: "acme" },
        zdr: true
      },
      headers: { "x-session-affinity": "s-1" },
      input: {},
      model: "anthropic/claude-opus-4.8"
    });
    expect(headersOf(calls[0])).toEqual({
      authorization: "Bearer token-1",
      "cf-aig-byok-alias": "team-a",
      "cf-aig-cache-ttl": "60",
      "cf-aig-gateway-id": "prod",
      "cf-aig-metadata": '{"tenant":"acme"}',
      "content-type": "application/json",
      "x-session-affinity": "s-1"
    });
  });

  it("does not let a caller's header replace the token", async () => {
    const calls = stubFetch(() => new Response("{}"));
    await createTransport(ACCOUNT).run({
      gateway: GATEWAY,
      headers: { Authorization: "Bearer other" },
      input: {},
      model: "anthropic/claude-opus-4.8"
    });
    expect(headersOf(calls[0]).authorization).toBe("Bearer token-1");
  });

  it("sends a Workers AI model to its own run route with its input, and unwraps the envelope", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [],
            messages: [],
            result: { response: "hi" },
            success: true
          }),
          { headers: { "content-type": "application/json" } }
        )
    );
    const response = await createTransport(ACCOUNT).run({
      gateway: { byokAlias: "team-a", id: "prod" },
      headers: {},
      input: { messages: [{ content: "hi", role: "user" }] },
      model: "@cf/zai-org/glm-4.7-flash"
    });
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/zai-org/glm-4.7-flash"
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messages: [{ content: "hi", role: "user" }]
    });
    expect(headersOf(calls[0])).not.toHaveProperty("cf-aig-byok-alias");
    expect(headersOf(calls[0])["cf-aig-gateway-id"]).toBe("prod");
    expect(await response.json()).toEqual({ response: "hi" });
  });

  it("leaves a Workers AI error response for the caller", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ code: 5007, message: "No such model" }]
          }),
          { headers: { "content-type": "application/json" }, status: 400 }
        )
    );
    const response = await createTransport(ACCOUNT).run({
      gateway: GATEWAY,
      headers: {},
      input: {},
      model: "@cf/nope/nope"
    });
    expect(response.status).toBe(400);
  });

  it("normalizes a thrown fetch failure into a CloudflareAIError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    await expect(
      createTransport(ACCOUNT).run({
        gateway: GATEWAY,
        headers: {},
        input: {},
        model: "anthropic/claude-opus-4.8"
      })
    ).rejects.toBeInstanceOf(CloudflareAIError);
  });

  it("sends a raw audio body to Workers AI's run route, the other fields as query parameters", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({ result: { results: {} }, success: true }),
          {
            headers: { "content-type": "application/json" }
          }
        )
    );
    const response = await createTransport(ACCOUNT).run({
      audio: { bytes: new Uint8Array([0, 1, 2]), contentType: "audio/mpeg" },
      gateway: { cacheTtl: 60, id: "prod" },
      headers: {},
      input: { language: "en" },
      model: "@cf/deepgram/nova-3"
    });
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/deepgram/nova-3?language=en"
    );
    expect(calls[0]?.init.body).toEqual(new Uint8Array([0, 1, 2]));
    expect(headersOf(calls[0])).toEqual({
      authorization: "Bearer token-1",
      "content-type": "audio/mpeg"
    });
    expect(await response.json()).toEqual({ results: {} });
  });

  // TODO: the public resume route (`gateway.ai.cloudflare.com/v1/{account}/
  // {gateway}/run/{runId}/resume`) answers 2036 unless the gateway has AI
  // Gateway's unified run flag, and the REST API has none. Turn this on once
  // it is open to every gateway.
  it.todo("resumes a dropped REST API stream from the last complete event");
});

describe("core transport - provider-native requests over HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the vendor's request to gateway.ai.cloudflare.com with the token as cf-aig-authorization", async () => {
    const calls = stubFetch(() => new Response(VENDOR_BODY, { status: 200 }));
    const response = await createTransport(ACCOUNT).native(
      nativeRequest({
        gateway: { byokAlias: "team-a", id: "prod", zdr: true }
      })
    );
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-1/prod/anthropic/v1/messages"
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0])).toEqual({
      "anthropic-version": "2023-06-01",
      "cf-aig-authorization": "Bearer token-1",
      "cf-aig-byok-alias": "team-a",
      "cf-aig-zdr": "true"
    });
    expect(await response.text()).toBe(VENDOR_BODY);
  });

  it("does not let a caller's header replace the token", async () => {
    const calls = stubFetch(() => new Response(VENDOR_BODY));
    await createTransport(ACCOUNT).native(
      nativeRequest({
        headers: { "CF-AIG-Authorization": "Bearer other" }
      })
    );
    expect(headersOf(calls[0])["cf-aig-authorization"]).toBe("Bearer token-1");
  });

  it("streams a stream body, half-duplex as Node's fetch requires", async () => {
    const calls = stubFetch(() => new Response(VENDOR_BODY));
    const body = new Request("https://example.com", {
      body: "{}",
      method: "POST"
    }).body;
    await createTransport(ACCOUNT).native(nativeRequest({ body }));
    expect(calls[0]?.init.body).toBe(body);
    expect((calls[0]!.init as { duplex?: string }).duplex).toBe("half");
  });

  it("returns the vendor's own error response untouched", async () => {
    stubFetch(() => new Response('{"type":"error"}', { status: 429 }));
    const response = await createTransport(ACCOUNT).native(nativeRequest());
    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"type":"error"}');
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
