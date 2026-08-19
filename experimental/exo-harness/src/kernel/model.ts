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
 * API. The workers-ai-provider openai plugin speaks Chat Completions only
 * — luna/sol/terra reject that with a 400. Returns the bare model id, or
 * null if this slug is not an OpenAI catalog model.
 */
export function openaiResponsesModelId(slug: string): string | null {
  if (!slug.startsWith("openai/")) return null;
  const id = slug.slice("openai/".length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Minimal `env.AI` surface used to forward an @ai-sdk/openai Responses
 * body onto the Unified Billing run path.
 *
 * Do not use `createGatewayFetch` here. That helper is the provider-native
 * gateway passthrough (`env.AI.gateway(id).run([{ provider: "openai" }])`).
 * It strips Authorization so Unified Billing can apply — but that path is
 * BYOK, so OpenAI then 401s with "Missing bearer or basic authentication
 * in header". `env.AI.run(slug, body)` is the documented no-key path.
 */
export interface AiRunBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<Response>;
}

export function parseJsonRequestBody(
  body: BodyInit | null | undefined
): Record<string, unknown> {
  if (body == null) return {};
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, unknown>;
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
  }
  if (body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
  }
  throw new Error("openai Responses fetch: request body must be JSON text");
}

/**
 * Hijack @ai-sdk/openai's outbound `/v1/responses` call and send the same
 * body through `env.AI.run(slug, …, { returnRawResponse: true })`.
 */
export function createBindingRunFetch(options: {
  binding: AiRunBinding;
  slug: string;
  gateway: string;
}): typeof globalThis.fetch {
  const { binding, slug, gateway } = options;
  return (async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const body = parseJsonRequestBody(init?.body);
    // The slug carries the model; extras can trip input validators.
    delete body.model;
    const resp = await binding.run(slug, body, {
      gateway: { id: gateway },
      returnRawResponse: true,
      ...(init?.signal ? { signal: init.signal } : {})
    });
    if (!resp.ok) {
      throw new Error(await gatewayErrorMessage(resp));
    }
    return resp;
  }) as typeof globalThis.fetch;
}

/**
 * Prefer the gateway/provider JSON body over HTTP status text.
 * A 402 arrives as "Payment required" even when the body says
 * "Gateway authentication is required to use unified billing."
 */
export async function gatewayErrorMessage(resp: Response): Promise<string> {
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim().slice(0, 400);
    }
    if (parsed.error && typeof parsed.error === "object") {
      const msg = (parsed.error as { message?: unknown }).message;
      if (typeof msg === "string" && msg.trim()) {
        return msg.trim().slice(0, 400);
      }
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim().slice(0, 400);
    }
  } catch {
    // not JSON
  }
  const trimmed = text.trim();
  if (trimmed) return trimmed.slice(0, 400);
  return resp.statusText.trim() || `model call failed (${resp.status})`;
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
