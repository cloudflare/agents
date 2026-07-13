import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  defaultSettingsMiddleware,
  type LanguageModel,
  wrapLanguageModel
} from "ai";
import { createClientFallbackModel } from "workers-ai-provider";

const AI_GATEWAY_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway";
const PROJECT_METADATA = JSON.stringify({
  project: "agents-team-agent-think"
});

export function createAgentThinkModel(
  token: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): LanguageModel {
  const normalizedToken = token?.trim() ?? "";
  if (!normalizedToken) {
    throw new Error("CLOUDFLARE_AIG_TOKEN is not configured");
  }

  const gatewayFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    // Provider SDKs add upstream credentials by default. The team token
    // authenticates AI Gateway, which supplies provider access itself.
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("cf-aig-authorization", `Bearer ${normalizedToken}`);
    headers.set("cf-aig-metadata", PROJECT_METADATA);
    return fetchImpl(input, { ...init, headers });
  };

  const openai = createOpenAI({
    apiKey: "unused",
    baseURL: `${AI_GATEWAY_BASE_URL}/openai`,
    fetch: gatewayFetch
  });
  const anthropic = createAnthropic({
    apiKey: "unused",
    baseURL: `${AI_GATEWAY_BASE_URL}/anthropic`,
    fetch: gatewayFetch
  });
  const primary = withProviderOptions(openai.chat("gpt-5.5"), {
    openai: { reasoningEffort: "medium" }
  });
  const fallback = withProviderOptions(anthropic("claude-opus-4-8"), {
    anthropic: { thinking: { type: "adaptive" }, effort: "medium" }
  });

  return createClientFallbackModel([
    { slug: "openai/gpt-5.5", model: primary, transport: "gateway" },
    {
      slug: "anthropic/claude-opus-4-8",
      model: fallback,
      transport: "gateway"
    }
  ]);
}

function withProviderOptions(
  model: ReturnType<typeof wrapLanguageModel>,
  providerOptions: NonNullable<
    Parameters<
      typeof defaultSettingsMiddleware
    >[0]["settings"]["providerOptions"]
  >
): ReturnType<typeof wrapLanguageModel> {
  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions }
    })
  });
}
