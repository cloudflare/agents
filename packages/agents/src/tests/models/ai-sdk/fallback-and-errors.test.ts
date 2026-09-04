import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { CloudflareAIError, createAI } from "../../../models/ai-sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  asAi,
  fakeGatewayBinding,
  callOptions,
  collect,
  fakeBinding,
  jsonResponse,
  sseResponse
} from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";
/** A second Workers AI model, so a chain has a distinguishable leg. */
const SECOND = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A third leg, so an exhausted chain reports more than two models. */
const THIRD = "@cf/qwen/qwen3-30b-a3b-fp8";

const okBody = {
  choices: [
    { finish_reason: "stop", message: { content: "ok", role: "assistant" } }
  ]
};

/** The live gateway error envelope: `error` singular, an array of one. */
const gatewayError = (code: number, message: string, status: number) => ({
  description: status === 402 ? "Invalid User Credentials" : "User Input Error",
  error: [{ code, message }],
  httpCode: status,
  internalCode: code,
  message,
  messages: [],
  name: "AiGatewayError",
  requestId: "05b36cf6-7276-4ca3-b609-3a5b4069e272",
  result: [],
  success: false
});

async function failure(
  run: () => PromiseLike<unknown>
): Promise<CloudflareAIError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CloudflareAIError);
    return error as CloudflareAIError;
  }
  throw new Error("expected the call to fail");
}

describe("error mapping", () => {
  it("classifies a 404 model-not-found gateway envelope", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(gatewayError(7003, `Model not found: ${SECOND}`, 404), {
        status: 404
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() => ai(SECOND).doGenerate(callOptions()));

    expect(error.code).toBe("not-found");
    expect(error.status).toBe(404);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toBe(`Model not found: ${SECOND}`);
    expect(error.model).toBe(SECOND);
    expect(error.attempts).toBeUndefined();
  });

  it("classifies a 402 insufficient-balance envelope as a gateway error", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        gatewayError(
          2021,
          "Insufficient balance; add money to your gateway or use BYOK",
          402
        ),
        { status: 402 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() => ai(SECOND).doGenerate(callOptions()));

    expect(error.code).toBe("gateway-error");
    expect(error.status).toBe(402);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toMatch(/Insufficient balance/);
  });

  it("reads the live 400 envelope a rejected OpenAI parameter produces", async () => {
    // Captured live over chat completions (`max_tokens` → 400): the gateway
    // envelope carries the provider's own wording under `error[0]`.
    const message =
      "Model execution failed (User Input Error): Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          description: "User Input Error",
          error: [{ code: 7003, message }],
          httpCode: 400,
          internalCode: 7003,
          message,
          messages: [],
          name: "AiGatewayError",
          requestId: "2c10b544-8b38-41b7-a0fc-3cbc5f3c1330",
          result: [],
          success: false
        },
        { status: 400 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() =>
      ai(SECOND).doGenerate(callOptions({ maxOutputTokens: 64 }))
    );

    expect(error.code).toBe("bad-request");
    expect(error.status).toBe(400);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toMatch(/Use 'max_completion_tokens' instead/);
    // The body that produced it is the one the model actually sent.
    expect(binding.calls[0].input).toHaveProperty("max_tokens", 64);
  });

  it("makes 429 retryable and 401 not", async () => {
    const binding = fakeBinding((call) =>
      jsonResponse(
        { errors: [{ code: 1, message: "nope" }] },
        { status: call.model === MODEL ? 429 : 401 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });

    const rateLimited = await failure(() =>
      ai(MODEL).doGenerate(callOptions())
    );
    expect(rateLimited.code).toBe("rate-limit");
    expect(rateLimited.isRetryable).toBe(true);

    const unauthorized = await failure(() =>
      ai(SECOND).doGenerate(callOptions())
    );
    expect(unauthorized.code).toBe("auth");
    expect(unauthorized.isRetryable).toBe(false);
    expect(unauthorized.message).toBe("nope");
  });

  it("reads the AiError validation envelope (message only)", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          description: "Bad input",
          httpCode: 400,
          internalCode: 5006,
          message: "AiError: Bad input: Error: oneOf at '/' not met",
          name: "AiError",
          requestId: "r1"
        },
        { status: 400 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() => ai(MODEL).doGenerate(callOptions()));

    expect(error.code).toBe("bad-request");
    expect(error.message).toMatch(/oneOf at '\/' not met/);
  });

  it("falls back to description when there is no message", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(
        {
          description: "Model ID missing",
          internalCode: 7000,
          name: "Internal Error"
        },
        { status: 500 }
      )
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() => ai(MODEL).doGenerate(callOptions()));

    expect(error.code).toBe("provider-error");
    expect(error.isRetryable).toBe(true);
    expect(error.message).toBe("Model ID missing");
  });

  it("uses the raw body when the error is not JSON", async () => {
    const binding = fakeBinding(
      () => new Response("upstream exploded", { status: 503 })
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() => ai(MODEL).doGenerate(callOptions()));

    expect(error.message).toBe("upstream exploded");
    expect(error.isRetryable).toBe(true);
  });

  it("normalizes a thrown binding error with an internal code", async () => {
    const binding = fakeBinding(() => {
      throw new Error("3040: Capacity temporarily exceeded");
    });
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() => ai(MODEL).doGenerate(callOptions()));

    expect(error.status).toBe(429);
    expect(error.code).toBe("rate-limit");
    expect(error.isRetryable).toBe(true);
    expect(error.data).toEqual({ code: 3040 });
  });

  it("lets abort errors through untouched", async () => {
    const binding = fakeBinding(() => {
      throw new DOMException("aborted", "AbortError");
    });
    const ai = createAI({ binding: asAi(binding) });
    await expect(
      ai(MODEL, { fallback: [SECOND] }).doGenerate(callOptions())
    ).rejects.toThrow(/aborted/);
    // The fallback leg must not run for an abort.
    expect(binding.calls).toHaveLength(1);
  });
});

describe("fallback", () => {
  it("tries each leg in order and reports the leg that answered", async () => {
    const binding = fakeBinding((call) =>
      call.model === SECOND
        ? jsonResponse(gatewayError(2021, "Insufficient balance", 402), {
            status: 402
          })
        : jsonResponse(okBody)
    );
    const ai = createAI({ binding: asAi(binding) });
    const result = await ai(SECOND, { fallback: [MODEL] }).doGenerate(
      callOptions()
    );

    expect(binding.calls.map((call) => call.model)).toEqual([SECOND, MODEL]);
    expect(result.content).toEqual([{ text: "ok", type: "text" }]);
    expect(result.providerMetadata?.cloudflare).toMatchObject({
      model: MODEL
    });
    expect(result.response?.modelId).toBe(MODEL);
  });

  it("collects every attempt when all legs fail", async () => {
    const binding = fakeBinding((call) =>
      jsonResponse(gatewayError(7003, `Model not found: ${call.model}`, 404), {
        status: 404
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    const error = await failure(() =>
      ai(SECOND, {
        fallback: [MODEL, THIRD]
      }).doGenerate(callOptions())
    );

    expect(error.attempts?.map((attempt) => attempt.model)).toEqual([
      SECOND,
      MODEL,
      THIRD
    ]);
    expect(error.code).toBe("not-found");
    expect(error.status).toBe(404);
    expect(error.message).toBe(
      `All models failed (${SECOND}, ${MODEL}, ${THIRD}). Last error: Model not found: ${THIRD}`
    );
    expect(error.cause).toBeInstanceOf(CloudflareAIError);
  });

  it("falls back for a stream that fails before it starts", async () => {
    const binding = fakeBinding((call) =>
      call.model === SECOND
        ? jsonResponse(gatewayError(2021, "Insufficient balance", 402), {
            status: 402
          })
        : sseResponse([
            JSON.stringify({
              choices: [
                {
                  delta: { content: "second" },
                  finish_reason: "stop",
                  index: 0
                }
              ]
            }),
            "[DONE]"
          ])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { stream } = await ai(SECOND, { fallback: [MODEL] }).doStream(
      callOptions()
    );
    const parts = await collect(stream);

    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("second");
  });

  it("accepts a fallback list supplied per call", async () => {
    const binding = fakeBinding((call) =>
      call.model === SECOND
        ? jsonResponse(gatewayError(2021, "Insufficient balance", 402), {
            status: 402
          })
        : jsonResponse(okBody)
    );
    const ai = createAI({ binding: asAi(binding) });
    await ai(SECOND).doGenerate(
      callOptions({
        providerOptions: { cloudflare: { fallback: [MODEL] } }
      })
    );
    expect(binding.calls.map((call) => call.model)).toEqual([SECOND, MODEL]);
  });

  it("refuses a third-party id in a per-call fallback list", async () => {
    const binding = fakeBinding(() => jsonResponse(okBody));
    const ai = createAI({ binding: asAi(binding) });

    const caught = await ai(MODEL)
      .doGenerate(
        callOptions({
          providerOptions: {
            cloudflare: { fallback: ["google/gemini-3-flash"] }
          }
        })
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message).toMatch(/@ai-sdk\/google/);
    // Nothing ran: the leg is refused where it was written, not mid-chain.
    expect(binding.calls).toHaveLength(0);
  });

  it("surfaces the error through generateText without retrying", async () => {
    const binding = fakeBinding(() =>
      jsonResponse(gatewayError(7003, `Model not found: ${MODEL}`, 404), {
        status: 404
      })
    );
    const ai = createAI({ binding: asAi(binding) });
    await expect(
      generateText({ maxRetries: 0, model: ai(MODEL), prompt: "hi" })
    ).rejects.toThrow(/Model not found/);
    expect(binding.calls).toHaveLength(1);
  });
});

describe("fallback chains that end on a vendor leg", () => {
  it("carries the vendor leg's own failure into the chain error", async () => {
    // The primary fails in the gateway (a billing envelope); the fallback leg
    // is a vendor model whose own 400 must survive as the chain's verdict.
    const anthropic = createAnthropic({ apiKey: "cloudflare" });
    const binding = fakeGatewayBinding({
      universal: (_call, index) =>
        index === 0
          ? jsonResponse(gatewayError(2021, "Insufficient balance", 402), {
              status: 402
            })
          : jsonResponse(
              {
                error: { message: "bad body", type: "invalid_request_error" },
                type: "error"
              },
              { status: 400 }
            )
    });
    const ai = createAI({ binding: asAi(binding) });
    const model = ai(anthropic("claude-opus-4-8"), {
      fallback: [ai(anthropic("claude-haiku-4-5"))]
    });
    const error = await failure(() => model.doGenerate(callOptions()));

    expect(error).toBeInstanceOf(CloudflareAIError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("bad-request");
    expect(error.isRetryable).toBe(false);
    expect(error.responseBody).toContain("bad body");
    expect(error.attempts?.map((attempt) => attempt.model)).toEqual([
      "claude-opus-4-8",
      "claude-haiku-4-5"
    ]);
    expect(binding.universal).toHaveLength(2);
  });
});
