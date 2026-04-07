import { describe, it, expect, assert } from "vitest";
import {
  detectProviders,
  resolveProviders,
  inferProviderFromModel,
  describeRequiredEnvVars,
  getProviderDisplayName
} from "../providers";
import type { AllProviderCredentials, ProviderID } from "../types";

describe("detectProviders", () => {
  it("returns null when no credentials are present", () => {
    expect(detectProviders({})).toBeNull();
    expect(detectProviders({ UNRELATED: "value" })).toBeNull();
  });

  it("detects Anthropic from ANTHROPIC_API_KEY", () => {
    const result = detectProviders({ ANTHROPIC_API_KEY: "sk-ant-123" });
    assert(result, "expected non-null result");
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].provider).toBe("anthropic");
    expect(result.defaultProvider).toBe("anthropic");
  });

  it("detects OpenAI from OPENAI_API_KEY", () => {
    const result = detectProviders({ OPENAI_API_KEY: "sk-proj-123" });
    assert(result, "expected non-null result");
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].provider).toBe("openai");
  });

  it("detects Cloudflare from CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_KEY", () => {
    const result = detectProviders({
      CLOUDFLARE_ACCOUNT_ID: "abc123",
      CLOUDFLARE_API_KEY: "key456"
    });
    assert(result, "expected non-null result");
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].provider).toBe("cloudflare-workers-ai");
  });

  it("requires both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY", () => {
    expect(detectProviders({ CLOUDFLARE_ACCOUNT_ID: "abc123" })).toBeNull();
    expect(detectProviders({ CLOUDFLARE_API_KEY: "key456" })).toBeNull();
  });

  it("detects multiple providers simultaneously", () => {
    const result = detectProviders({
      ANTHROPIC_API_KEY: "sk-ant-123",
      OPENAI_API_KEY: "sk-proj-123",
      CLOUDFLARE_ACCOUNT_ID: "abc",
      CLOUDFLARE_API_KEY: "key"
    });
    assert(result, "expected non-null result");
    expect(result.credentials).toHaveLength(3);
  });

  it("infers default provider from userConfigModel", () => {
    const result = detectProviders(
      {
        ANTHROPIC_API_KEY: "sk-ant-123",
        OPENAI_API_KEY: "sk-proj-123"
      },
      "openai/gpt-5.4"
    );
    assert(result, "expected non-null result");
    expect(result.defaultProvider).toBe("openai");
  });

  it("falls back to first detected if userConfigModel provider not found", () => {
    const result = detectProviders(
      { ANTHROPIC_API_KEY: "sk-ant-123" },
      "openai/gpt-5.4"
    );
    assert(result, "expected non-null result");
    // OpenAI not detected, so default stays as first detected (anthropic)
    expect(result.defaultProvider).toBe("anthropic");
  });

  it("ignores empty string env vars", () => {
    expect(detectProviders({ ANTHROPIC_API_KEY: "" })).toBeNull();
    expect(detectProviders({ OPENAI_API_KEY: "" })).toBeNull();
  });

  it("ignores non-string env vars", () => {
    expect(detectProviders({ ANTHROPIC_API_KEY: 123 })).toBeNull();
    expect(detectProviders({ ANTHROPIC_API_KEY: true })).toBeNull();
  });
});

describe("resolveProviders", () => {
  it("resolves a single Anthropic provider", () => {
    const all: AllProviderCredentials = {
      credentials: [{ provider: "anthropic", apiKey: "sk-ant-123" }],
      defaultProvider: "anthropic"
    };
    const resolved = resolveProviders(all);

    expect(resolved.id).toBe("anthropic");
    expect(resolved.config.model).toContain("anthropic/");
    expect(resolved.env.ANTHROPIC_API_KEY).toBe("sk-ant-123");
    expect(resolved.auths).toHaveLength(1);
    expect(resolved.auths[0].providerID).toBe("anthropic");
    expect(resolved.config.permission).toEqual({
      "*": "allow",
      question: "deny"
    });
  });

  it("resolves a single OpenAI provider", () => {
    const all: AllProviderCredentials = {
      credentials: [{ provider: "openai", apiKey: "sk-proj-123" }],
      defaultProvider: "openai"
    };
    const resolved = resolveProviders(all);

    expect(resolved.id).toBe("openai");
    expect(resolved.config.model).toContain("openai/");
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-proj-123");
  });

  it("resolves a single Cloudflare provider", () => {
    const all: AllProviderCredentials = {
      credentials: [
        {
          provider: "cloudflare-workers-ai",
          accountId: "abc123",
          apiKey: "key456"
        }
      ],
      defaultProvider: "cloudflare-workers-ai"
    };
    const resolved = resolveProviders(all);

    expect(resolved.id).toBe("cloudflare-workers-ai");
    expect(resolved.config.model).toContain("cloudflare-workers-ai/");
    expect(resolved.env.CLOUDFLARE_ACCOUNT_ID).toBe("abc123");
    expect(resolved.env.CLOUDFLARE_API_KEY).toBe("key456");
  });

  it("merges multiple providers into a single config", () => {
    const all: AllProviderCredentials = {
      credentials: [
        { provider: "anthropic", apiKey: "sk-ant" },
        { provider: "openai", apiKey: "sk-proj" }
      ],
      defaultProvider: "anthropic"
    };
    const resolved = resolveProviders(all);

    expect(resolved.config.model).toContain("anthropic/");
    expect(resolved.env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(resolved.env.OPENAI_API_KEY).toBe("sk-proj");
    expect(resolved.auths).toHaveLength(2);
    expect(resolved.config.provider).toHaveProperty("anthropic");
    expect(resolved.config.provider).toHaveProperty("openai");
  });

  it("userConfig overrides take precedence via deep merge", () => {
    const all: AllProviderCredentials = {
      credentials: [{ provider: "anthropic", apiKey: "sk-ant" }],
      defaultProvider: "anthropic"
    };
    const resolved = resolveProviders(all, {
      model: "anthropic/claude-opus-5",
      autoupdate: true
    });

    expect(resolved.config.model).toBe("anthropic/claude-opus-5");
    expect(resolved.config.autoupdate).toBe(true);
    // Permission should be preserved (not overwritten)
    expect(resolved.config.permission).toEqual({
      "*": "allow",
      question: "deny"
    });
  });

  it("sets autoupdate to false by default", () => {
    const all: AllProviderCredentials = {
      credentials: [{ provider: "anthropic", apiKey: "sk-ant" }],
      defaultProvider: "anthropic"
    };
    const resolved = resolveProviders(all);
    expect(resolved.config.autoupdate).toBe(false);
  });
});

describe("inferProviderFromModel", () => {
  it("returns anthropic for anthropic/ prefix", () => {
    expect(inferProviderFromModel("anthropic/claude-sonnet-4-20250514")).toBe(
      "anthropic"
    );
  });

  it("returns openai for openai/ prefix", () => {
    expect(inferProviderFromModel("openai/gpt-5.4")).toBe("openai");
  });

  it("returns cloudflare-workers-ai for that prefix", () => {
    expect(inferProviderFromModel("cloudflare-workers-ai/@cf/meta/llama")).toBe(
      "cloudflare-workers-ai"
    );
  });

  it("returns null for unknown prefix", () => {
    expect(inferProviderFromModel("google/gemini-2")).toBeNull();
    expect(inferProviderFromModel("local-model")).toBeNull();
  });
});

describe("describeRequiredEnvVars", () => {
  it("returns a non-empty string mentioning all providers", () => {
    const desc = describeRequiredEnvVars();
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).toContain("ANTHROPIC_API_KEY");
    expect(desc).toContain("OPENAI_API_KEY");
    expect(desc).toContain("CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("getProviderDisplayName", () => {
  it("returns correct display names", () => {
    expect(getProviderDisplayName("anthropic")).toBe("Anthropic");
    expect(getProviderDisplayName("openai")).toBe("OpenAI");
    expect(getProviderDisplayName("cloudflare-workers-ai")).toBe(
      "Cloudflare Workers AI"
    );
  });
});
