import { createOpenAI } from "@ai-sdk/openai";

const EXO_MANAGED_OPENAI_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/27b146402af2103944379f33841b6234/project-gateway/openai/v1";
const EXO_GATEWAY_METADATA = JSON.stringify({
  project: "agents-team-exo-harness"
});

/** A validated model selection from the evolvable harness policy. */
export type ParsedModelSpec =
  | { kind: "mock" }
  | { kind: "workers-ai"; id: string }
  | { kind: "openai"; id: string };

/** Parse the supported offline, Workers AI, and managed OpenAI model forms. */
export function parseModelSpec(spec: string): ParsedModelSpec {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error('Model spec is empty — set /harness/policy.json "model"');
  }
  if (trimmed === "mock") return { kind: "mock" };

  if (trimmed.startsWith("workers-ai:")) {
    const id = trimmed.slice("workers-ai:".length).trim();
    if (id.length === 0) {
      throw new Error("Workers AI model id is empty");
    }
    return { kind: "workers-ai", id };
  }

  if (trimmed.startsWith("@cf/")) {
    return { kind: "workers-ai", id: trimmed };
  }

  for (const prefix of ["openai/", "openai:"]) {
    if (trimmed.startsWith(prefix)) {
      const id = trimmed.slice(prefix.length).trim();
      if (id.length === 0) {
        throw new Error("OpenAI model id is empty");
      }
      return { kind: "openai", id };
    }
  }

  const providerSeparator = trimmed.search(/[/:]/);
  if (providerSeparator > 0) {
    const provider = trimmed.slice(0, providerSeparator);
    throw new Error(
      `Unsupported model provider "${provider}" — use "openai/<id>" or a Workers AI model`
    );
  }

  throw new Error(
    `Unknown model "${spec}" — use "mock", "workers-ai:<id>", or "openai/<id>"`
  );
}

type ExoGatewayOpenAIModel = ReturnType<
  ReturnType<typeof createOpenAI>["responses"]
>;

/**
 * Create an OpenAI Responses model routed through the authenticated team AI
 * Gateway. Provider credentials are removed before the final network call.
 */
export function createExoGatewayOpenAIModel(
  modelId: string,
  token: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): ExoGatewayOpenAIModel {
  const normalizedToken = token?.trim() ?? "";
  if (!normalizedToken) {
    throw new Error("CLOUDFLARE_AIG_TOKEN is not configured");
  }

  const gatewayFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("cf-aig-authorization", `Bearer ${normalizedToken}`);
    headers.set("cf-aig-metadata", EXO_GATEWAY_METADATA);
    return fetchImpl(input, { ...init, headers });
  };

  return createOpenAI({
    apiKey: "unused",
    baseURL: EXO_MANAGED_OPENAI_BASE_URL,
    fetch: gatewayFetch
  }).responses(modelId);
}

/** Return a bounded, one-line model error safe for the client and journal. */
export function publicModelError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? String(error));
  const oneLine = raw.split("\n")[0]?.trim() || "model call failed";
  return oneLine.slice(0, 400);
}
