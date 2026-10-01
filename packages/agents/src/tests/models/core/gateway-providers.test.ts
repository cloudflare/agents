/**
 * The AI Gateway provider table: a vendor's own request URL in, the universal
 * request's `{ provider, endpoint }` out.
 */
import { describe, expect, it } from "vitest";
import {
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_NAMES,
  gatewayProviderForHost,
  gatewaySlugForBaseUrl,
  requireGatewayProvider,
  resolveGatewayProvider
} from "../../../models/core/gateway-providers";

describe("core gateway providers — routing", () => {
  it("maps each vendor's base URL onto its gateway slug and endpoint", () => {
    const cases: [url: string, provider: string, endpoint: string][] = [
      ["https://api.anthropic.com/v1/messages", "anthropic", "v1/messages"],
      ["https://api.openai.com/v1/responses", "openai", "v1/responses"],
      [
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        "google-ai-studio",
        "v1beta/models/gemini-3-flash:generateContent"
      ],
      [
        "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/m:generateContent",
        "google-vertex-ai",
        "v1/projects/p/locations/us-central1/publishers/google/models/m:generateContent"
      ],
      ["https://api.x.ai/v1/chat/completions", "grok", "v1/chat/completions"],
      [
        "https://api.mistral.ai/v1/chat/completions",
        "mistral",
        "v1/chat/completions"
      ],
      [
        "https://api.deepseek.com/chat/completions",
        "deepseek",
        "chat/completions"
      ],
      [
        "https://api.groq.com/openai/v1/chat/completions",
        "groq",
        "chat/completions"
      ],
      [
        "https://openrouter.ai/api/v1/chat/completions",
        "openrouter",
        "v1/chat/completions"
      ],
      [
        "https://api.cerebras.ai/v1/chat/completions",
        "cerebras",
        "v1/chat/completions"
      ],
      ["https://api.cohere.com/v2/chat", "cohere", "v2/chat"],
      [
        "https://api-inference.huggingface.co/models/bigcode/starcoder",
        "huggingface",
        "bigcode/starcoder"
      ],
      [
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke",
        "aws-bedrock",
        "bedrock-runtime/us-east-1/model/m/invoke"
      ],
      [
        "https://acme.openai.azure.com/openai/deployments/gpt/chat/completions",
        "azure-openai",
        "acme/gpt/chat/completions"
      ],
      [
        "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions",
        "workers-ai",
        "v1/chat/completions"
      ],
      [
        "https://api.perplexity.ai/chat/completions",
        "perplexity-ai",
        "chat/completions"
      ],
      [
        "https://api.replicate.com/v1/predictions",
        "replicate",
        "v1/predictions"
      ],
      [
        "https://api.elevenlabs.io/v1/text-to-speech/voice",
        "elevenlabs",
        "v1/text-to-speech/voice"
      ],
      ["https://api.cartesia.ai/tts/bytes", "cartesia", "tts/bytes"]
    ];
    for (const [url, provider, endpoint] of cases) {
      expect(resolveGatewayProvider(url)).toMatchObject({ endpoint, provider });
    }
  });

  it("keeps the query string on the endpoint", () => {
    expect(
      resolveGatewayProvider(
        "https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse"
      )?.endpoint
    ).toBe("v1beta/models/m:streamGenerateContent?alt=sse");
  });

  it("names the credential headers to strip", () => {
    expect(
      resolveGatewayProvider("https://api.anthropic.com/v1/messages")
        ?.authHeaders
    ).toEqual(["authorization", "x-api-key"]);
    expect(
      resolveGatewayProvider("https://generativelanguage.googleapis.com/v1")
        ?.authHeaders
    ).toEqual(["authorization", "x-goog-api-key"]);
    expect(
      resolveGatewayProvider("https://api.openai.com/v1/responses")?.authHeaders
    ).toEqual(["authorization"]);
    expect(
      resolveGatewayProvider(
        "https://acme.openai.azure.com/openai/deployments/gpt/chat/completions"
      )?.authHeaders
    ).toEqual(["authorization", "api-key"]);
  });

  it("answers undefined for an unrouted host and for a non-URL", () => {
    expect(resolveGatewayProvider("https://api.acme.test/v1/chat")).toBe(
      undefined
    );
    expect(resolveGatewayProvider("not a url")).toBe(undefined);
  });

  it("throws a TypeError naming the host and the provider list", () => {
    expect(() =>
      requireGatewayProvider("https://api.acme.test/v1/chat")
    ).toThrow(TypeError);
    expect(() =>
      requireGatewayProvider("https://api.acme.test/v1/chat")
    ).toThrow(/api\.acme\.test/);
    expect(() =>
      requireGatewayProvider("https://api.acme.test/v1/chat")
    ).toThrow(/anthropic/);
  });
});

describe("core gateway providers — bare hosts", () => {
  it("resolves a pi-ai style baseUrl and a bare host alike", () => {
    expect(gatewayProviderForHost("api.anthropic.com")?.name).toBe("anthropic");
    expect(gatewayProviderForHost("https://api.anthropic.com/v1")?.name).toBe(
      "anthropic"
    );
    expect(gatewayProviderForHost("api.openai.com/v1")?.name).toBe("openai");
    expect(gatewayProviderForHost("api.acme.test")).toBe(undefined);
  });
});

describe("core gateway providers — base URLs", () => {
  it("reads the slug out of a gateway-shaped base URL", () => {
    // The shape a generated Cloudflare registry writes: the account and
    // gateway are literal placeholders, and the slug is the last segment.
    expect(
      gatewaySlugForBaseUrl(
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic"
      )
    ).toBe("anthropic");
    expect(
      gatewaySlugForBaseUrl(
        "https://gateway.ai.cloudflare.com/v1/acct/prod/openai"
      )
    ).toBe("openai");
  });

  it("reads the slug out of a vendor's own base URL", () => {
    expect(gatewaySlugForBaseUrl("https://api.anthropic.com")).toBe(
      "anthropic"
    );
    expect(gatewaySlugForBaseUrl("api.groq.com/openai/v1")).toBe("groq");
  });

  it("throws a TypeError naming what it did not recognise", () => {
    expect(() =>
      gatewaySlugForBaseUrl(
        "https://gateway.ai.cloudflare.com/v1/acct/prod/acme"
      )
    ).toThrow(/no provider "acme"/);
    expect(() => gatewaySlugForBaseUrl("https://api.acme.test/v1")).toThrow(
      /api\.acme\.test/
    );
    expect(() => gatewaySlugForBaseUrl("api.acme.test")).toThrow(TypeError);
  });
});

describe("core gateway providers — table", () => {
  it("lists every name exactly once, in the declared order", () => {
    expect(GATEWAY_PROVIDERS.map((entry) => entry.name)).toEqual([
      ...GATEWAY_PROVIDER_NAMES
    ]);
    expect(new Set(GATEWAY_PROVIDER_NAMES).size).toBe(
      GATEWAY_PROVIDER_NAMES.length
    );
  });

  it("does not match a host outside its own row", () => {
    for (const entry of GATEWAY_PROVIDERS) {
      expect(entry.endpoint("https://api.acme.test/v1")).toBe(undefined);
    }
  });
});
