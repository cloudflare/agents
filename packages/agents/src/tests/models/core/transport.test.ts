/**
 * The universal AI Gateway path over the AI binding — the only backend there
 * is. The fixtures are the shapes captured live against the Demos account
 * (`research/43-demos-*`).
 */
import { describe, expect, it } from "vitest";
import { CloudflareAIError } from "../../../models/core/errors";
import type { ResolvedGateway } from "../../../models/core/settings";
import {
  createTransport,
  errorFromGatewayEnvelope,
  isGatewayErrorEnvelope,
  type UniversalRequest
} from "../../../models/core/transport";

interface GatewayCall {
  id: string;
  data: unknown;
  options: unknown;
}

/** An `Ai`-shaped binding whose `gateway(id).run` records the universal call. */
function fakeGatewayBinding(response: () => Response) {
  const calls: GatewayCall[] = [];
  const binding = {
    aiGatewayLogId: null,
    gateway(id: string) {
      return {
        async run(data: unknown, options: unknown) {
          calls.push({ data, id, options });
          return response();
        }
      };
    },
    run() {
      throw new Error("the run path is not used by universal requests");
    }
  };
  return { binding: binding as unknown as Ai, calls };
}

const GATEWAY: ResolvedGateway = { id: "prod" };

function universalRequest(
  overrides: Partial<UniversalRequest> = {}
): UniversalRequest {
  return {
    endpoint: "v1/messages",
    gateway: GATEWAY,
    headers: { "anthropic-version": "2023-06-01" },
    provider: "anthropic",
    query: { max_tokens: 8, model: "claude-opus-4-8" },
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

describe("core transport - universal request over the binding", () => {
  it("selects the gateway and forwards provider, endpoint, headers and body", async () => {
    const { binding, calls } = fakeGatewayBinding(
      () => new Response(VENDOR_BODY, { status: 200 })
    );
    const transport = createTransport({ binding });
    const response = await transport.universal(
      universalRequest({
        extraHeaders: { "x-trace": "1" },
        gateway: {
          cacheTtl: 60,
          collectLog: true,
          eventId: "evt-1",
          id: "prod",
          metadata: { tenant: "acme" },
          requestTimeoutMs: 9000,
          retries: { backoff: "linear", maxAttempts: 2 },
          skipCache: false
        }
      })
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("prod");
    expect(calls[0].data).toEqual({
      endpoint: "v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      provider: "anthropic",
      query: { max_tokens: 8, model: "claude-opus-4-8" }
    });
    expect(calls[0].options).toEqual({
      extraHeaders: { "x-trace": "1" },
      gateway: {
        cacheTtl: 60,
        collectLog: true,
        eventId: "evt-1",
        id: "prod",
        metadata: { tenant: "acme" },
        requestTimeoutMs: 9000,
        retries: { backoff: "linear", maxAttempts: 2 },
        skipCache: false
      },
      signal: undefined
    });
  });

  it("omits extraHeaders when there are none", async () => {
    const { binding, calls } = fakeGatewayBinding(
      () => new Response(VENDOR_BODY)
    );
    await createTransport({ binding }).universal(universalRequest());
    expect(calls[0].options).not.toHaveProperty("extraHeaders");
  });

  it("returns the vendor's own error response untouched", async () => {
    const { binding } = fakeGatewayBinding(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "model: claude-opus-4.8 was not found." },
            type: "error"
          }),
          { status: 404 }
        )
    );
    const response = await createTransport({ binding }).universal(
      universalRequest()
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ type: "error" });
  });

  it("normalizes a thrown binding failure into a CloudflareAIError", async () => {
    const binding = {
      gateway() {
        return {
          run() {
            throw new Error("3040: Capacity temporarily exceeded");
          }
        };
      }
    } as unknown as Ai;
    await expect(
      createTransport({ binding }).universal(universalRequest())
    ).rejects.toMatchObject({
      isRetryable: true,
      model: "claude-opus-4-8",
      name: "CloudflareAIError",
      status: 429
    });
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
