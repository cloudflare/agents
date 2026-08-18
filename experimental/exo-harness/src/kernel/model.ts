/**
 * Model spec parser — the string in /harness/policy.json (or MODEL_OVERRIDE)
 * is the only knob that picks a provider. Three shapes:
 *
 *   mock                         deterministic offline driver
 *   workers-ai:@cf/<id>          Workers AI via the AI binding
 *   @cf/<id>                     same, without the legacy prefix
 *   <provider>/<model>           third-party catalog via AI Gateway
 *   <provider>:<model>           same, colon form (matches workers-ai:)
 *
 * Catalog slugs (openai/gpt-5.4, anthropic/claude-sonnet-4-5, …) are billed
 * through AI Gateway Unified Billing — no provider API key in the worker.
 */

export type ParsedModelSpec =
  | { kind: "mock" }
  | { kind: "workers-ai"; id: string }
  | { kind: "catalog"; slug: string };

export function parseModelSpec(spec: string): ParsedModelSpec {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error('model spec is empty — set /harness/policy.json "model"');
  }
  if (trimmed === "mock") return { kind: "mock" };

  if (trimmed.startsWith("workers-ai:")) {
    const id = trimmed.slice("workers-ai:".length).trim();
    if (id.length === 0) {
      throw new Error("workers-ai: model id is empty");
    }
    return { kind: "workers-ai", id };
  }

  // Bare Workers AI ids (`@cf/...`) share a slash with catalog slugs but
  // must stay on the Workers AI path, not the gateway delegate.
  if (trimmed.startsWith("@cf/")) {
    return { kind: "workers-ai", id: trimmed };
  }

  if (trimmed.includes("/")) {
    return { kind: "catalog", slug: trimmed };
  }

  const colon = trimmed.indexOf(":");
  if (colon > 0 && colon < trimmed.length - 1) {
    return {
      kind: "catalog",
      slug: `${trimmed.slice(0, colon)}/${trimmed.slice(colon + 1)}`
    };
  }

  throw new Error(
    `Unknown model "${spec}" — use "mock", "workers-ai:<id>", or a catalog slug like "openai/gpt-5.4"`
  );
}

/**
 * OpenAI catalog slugs (`openai/gpt-5.6-luna`, …) must use the Responses
 * API. The workers-ai-provider run path speaks Chat Completions only —
 * luna/sol/terra reject that with a 400. Returns the bare model id, or
 * null if this slug is not an OpenAI catalog model.
 */
export function openaiResponsesModelId(slug: string): string | null {
  if (!slug.startsWith("openai/")) return null;
  const id = slug.slice("openai/".length).trim();
  return id.length > 0 ? id : null;
}

/** One-line, client-safe model/turn error (no stacks). */
export function publicModelError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const oneLine = raw.split("\n")[0]?.trim() || "model call failed";
  return oneLine.slice(0, 400);
}
