/**
 * Gateway delegate engine (prototype).
 *
 * This is the reference implementation of the `workers-ai-provider` catalog-model
 * delegate described in design/rfc-workers-ai-gateway-merge.md (§1 dispatch, §2
 * transport selection, §3 provider supply, §4 fallback). It is built here in the
 * harness — where `@ai-sdk/*` deps are installed and we can live-test against real
 * models — so the design is validated before it ports into the published package.
 *
 * What it does: given a `vendor/model` slug and a real `@ai-sdk/*` provider, it
 * builds a LanguageModel whose `fetch` is hijacked to dispatch through AI Gateway,
 * choosing the transport from the requested options:
 *
 *   - Run path     `env.AI.run(slug, body, { returnRawResponse })`     → resume (cf-aig-run-id)
 *   - Gateway path `env.AI.gateway(id).run([entry, …fallback])`        → server fallback / caching
 *
 * The SAME `@ai-sdk/*` provider parses the response either way (proven by the
 * /passthrough and /gw probes), so there is no per-provider parsing here.
 *
 * Portability note: in the package, the run-path provider factories
 * (createOpenAI().chat, createAnthropic(), …) are INJECTED from sub-path modules
 * (`workers-ai-provider/openai`, …) so `@ai-sdk/*` stays an OPTIONAL peer dep. Here
 * we register openai + anthropic directly because the harness has them installed.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

interface Env {
  AI: Ai;
}

// ---------------------------------------------------------------------------
// Slug parsing (RFC §3)
// ---------------------------------------------------------------------------

export interface ParsedSlug {
  /** First segment — the resolver key that selects how to dispatch. */
  resolverKey: string;
  /** Provider id sent to the gateway universal endpoint. */
  providerId: string;
  /** Remaining segments — the provider-native model id. */
  modelId: string;
}

export function parseSlug(slug: string): ParsedSlug {
  const slash = slug.indexOf("/");
  if (slash === -1) {
    throw new DelegateError(
      "config",
      `Slug "${slug}" has no resolver key. Use "vendor/model" (e.g. "openai/gpt-5.4").`
    );
  }
  const resolverKey = slug.slice(0, slash);
  const modelId = slug.slice(slash + 1);
  // Routing-layer providers (e.g. openrouter/anthropic/claude-…) keep the rest
  // of the path as the model id; providerId is always the first segment.
  return { resolverKey, providerId: resolverKey, modelId };
}

// ---------------------------------------------------------------------------
// Capability matrix + transport selection (RFC §2)
// ---------------------------------------------------------------------------

export type Transport = "run" | "gateway";

export interface DelegateOptions {
  gateway: string;
  /** Resumable streaming (run path). Defaults to true. */
  resume?: boolean;
  /** Cross-model fallback. "client" stays resumable; "server" uses gateway path. */
  fallback?: { mode: "client" | "server"; models: string[] };
  /** Gateway-path caching. */
  cacheTtl?: number;
  skipCache?: boolean;
  /** Escape hatch: force a transport. */
  transport?: Transport;
  /** Extra request headers (run path passes via extraHeaders; gateway via entry). */
  extraHeaders?: Record<string, string>;
}

interface Selection {
  transport: Transport;
  resumeEnabled: boolean;
  warnings: string[];
}

/**
 * Resolve the transport from requested options. Gateway-only features (server
 * fallback, caching) force the gateway path and disable resume — loudly. A hard
 * conflict (explicit resume:true + a gateway-only feature) throws.
 */
export function selectTransport(opts: DelegateOptions): Selection {
  const warnings: string[] = [];
  const wantsServerFallback = opts.fallback?.mode === "server";
  const wantsCaching = opts.cacheTtl !== undefined || opts.skipCache === true;
  const gatewayOnly = wantsServerFallback || wantsCaching;
  const resumeRequested = opts.resume === true;
  const resumeDefaulted = opts.resume === undefined;

  // Escape hatch wins, but still validate it can satisfy the options.
  if (opts.transport === "run" && gatewayOnly) {
    throw new DelegateError(
      "config",
      `transport:"run" cannot satisfy gateway-only options (${[
        wantsServerFallback && 'fallback.mode:"server"',
        wantsCaching && "cacheTtl/skipCache"
      ]
        .filter(Boolean)
        .join(", ")}). Use the gateway path or client-side fallback.`
    );
  }
  if (opts.transport === "gateway" && resumeRequested) {
    throw new DelegateError(
      "config",
      'transport:"gateway" cannot provide resume (cf-aig-run-id is run-path only).'
    );
  }

  if (gatewayOnly) {
    if (resumeRequested) {
      throw new DelegateError(
        "config",
        `resume:true conflicts with ${
          wantsServerFallback ? 'fallback.mode:"server"' : "cacheTtl/skipCache"
        }: resume (cf-aig-run-id) is only on the run path, which does not support ${
          wantsServerFallback ? "server-side fallback" : "caching"
        }. Use fallback.mode:"client" to keep resume, or drop resume.`
      );
    }
    if (resumeDefaulted) {
      warnings.push(
        `resume disabled: ${
          wantsServerFallback ? 'fallback.mode:"server"' : "caching"
        } requires the gateway path, which does not surface cf-aig-run-id. ` +
          'Use fallback.mode:"client" to keep resumable streaming.'
      );
    }
    return { transport: "gateway", resumeEnabled: false, warnings };
  }

  const transport = opts.transport ?? "run";
  return {
    transport,
    resumeEnabled: transport === "run" && opts.resume !== false,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy (RFC §8)
// ---------------------------------------------------------------------------

export type DelegateErrorKind =
  | "config"
  | "dispatch"
  | "provider"
  | "resume-expired";

export class DelegateError extends Error {
  constructor(
    public kind: DelegateErrorKind,
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "DelegateError";
  }
}

// ---------------------------------------------------------------------------
// Run-path provider factories (INJECTED in the package; registered here)
// ---------------------------------------------------------------------------

export type ProviderFactory = (args: {
  modelId: string;
  fetch: typeof globalThis.fetch;
}) => LanguageModel;

const RUN_FACTORIES: Record<string, ProviderFactory> = {
  // IMPORTANT: .chat() forces Chat Completions. Bare openai() defaults to the
  // Responses API in AI SDK v6, which the run catalog does not serve (RFC §10a).
  openai: ({ modelId, fetch }) =>
    createOpenAI({ apiKey: "unused", fetch }).chat(modelId),
  anthropic: ({ modelId, fetch }) =>
    createAnthropic({ apiKey: "unused", fetch })(modelId)
};

// ---------------------------------------------------------------------------
// Dispatch capture — what the harness reads back after a call
// ---------------------------------------------------------------------------

export interface DispatchCapture {
  transport: Transport;
  resumeEnabled: boolean;
  warnings: string[];
  runId: string | null;
  status: number | null;
  cfStep: string | null;
  cacheStatus: string | null;
  logId: string | null;
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    for (const [k, v] of h) out[k] = v;
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    Object.assign(out, h);
  }
  return out;
}

// Auth headers are stripped on the gateway path — unified billing / BYOK is the
// gateway's job, and forwarding a fake key would 401.
const STRIP_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "content-length",
  "host"
]);

// ---------------------------------------------------------------------------
// Forwarding fetch
// ---------------------------------------------------------------------------

function makeRunFetch(
  env: Env,
  slug: string,
  opts: DelegateOptions,
  capture: DispatchCapture
): typeof globalThis.fetch {
  return (async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const body = JSON.parse(asText(init?.body)) as Record<string, unknown>;
    delete body.model; // slug carries it (RFC §2 — both drop and keep are tolerated)
    const ai = env.AI as unknown as {
      run(
        m: string,
        i: Record<string, unknown>,
        o: Record<string, unknown>
      ): Promise<Response>;
    };
    const resp = await ai.run(slug, body, {
      gateway: { id: opts.gateway },
      returnRawResponse: true,
      ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
      ...(init?.signal ? { signal: init.signal } : {})
    });
    recordHeaders(capture, resp);
    return resp;
  }) as typeof globalThis.fetch;
}

function makeGatewayFetch(
  env: Env,
  parsed: ParsedSlug,
  opts: DelegateOptions,
  capture: DispatchCapture
): typeof globalThis.fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const endpoint = url.pathname.replace(/^\//, "") + (url.search || "");
    const body = JSON.parse(asText(init?.body)) as Record<string, unknown>;
    const reqHeaders = headersToObject(init?.headers);
    const headers: Record<string, string> = { ...opts.extraHeaders };
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }

    const primary = {
      provider: parsed.providerId,
      endpoint,
      headers,
      query: body
    };

    // Server-side fallback: same-vendor entries by swapping the model field.
    // (Cross-vendor server fallback needs per-entry body re-rendering — future.)
    const entries = [primary];
    if (opts.fallback?.mode === "server") {
      for (const fb of opts.fallback.models) {
        const fbParsed = parseSlug(fb);
        if (fbParsed.providerId !== parsed.providerId) {
          throw new DelegateError(
            "config",
            `Cross-vendor server-side fallback (${parsed.providerId} → ${fbParsed.providerId}) ` +
              'is not supported yet; use fallback.mode:"client" or same-vendor models.'
          );
        }
        entries.push({
          ...primary,
          query: { ...body, model: fbParsed.modelId }
        });
      }
    }

    const gw = (
      env.AI as unknown as {
        gateway(id: string): {
          run(b: unknown, o?: Record<string, unknown>): Promise<Response>;
        };
      }
    ).gateway(opts.gateway);
    const resp = await gw.run(entries);
    recordHeaders(capture, resp);
    return resp;
  }) as typeof globalThis.fetch;
}

function asText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return "{}";
}

function recordHeaders(capture: DispatchCapture, resp: Response): void {
  capture.status = resp.status;
  capture.runId = resp.headers.get("cf-aig-run-id");
  capture.cfStep = resp.headers.get("cf-aig-step");
  capture.cacheStatus = resp.headers.get("cf-aig-cache-status");
  capture.logId = resp.headers.get("cf-aig-log-id");
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface BuiltDelegate {
  model: LanguageModel;
  capture: DispatchCapture;
}

/**
 * Build a delegated LanguageModel for `slug` with the given options. Chooses the
 * transport from the capability matrix, wires the matching forwarding fetch, and
 * returns the model plus a `capture` object the caller reads after the run.
 */
export function buildDelegateModel(
  env: Env,
  slug: string,
  opts: DelegateOptions
): BuiltDelegate {
  const parsed = parseSlug(slug);
  const factory = RUN_FACTORIES[parsed.resolverKey];
  if (!factory) {
    throw new DelegateError(
      "config",
      `No provider factory registered for resolver key "${parsed.resolverKey}". ` +
        `Known: ${Object.keys(RUN_FACTORIES).join(", ")}.`
    );
  }

  const selection = selectTransport(opts);
  const capture: DispatchCapture = {
    transport: selection.transport,
    resumeEnabled: selection.resumeEnabled,
    warnings: selection.warnings,
    runId: null,
    status: null,
    cfStep: null,
    cacheStatus: null,
    logId: null
  };

  const fetchImpl =
    selection.transport === "run"
      ? makeRunFetch(env, slug, opts, capture)
      : makeGatewayFetch(env, parsed, opts, capture);

  const model = factory({ modelId: parsed.modelId, fetch: fetchImpl });
  return { model, capture };
}
