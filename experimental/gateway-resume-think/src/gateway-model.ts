/**
 * Minimal gateway delegate (vendored shape of `workers-ai-provider`'s
 * gateway-delegate + openai/anthropic plugins). Builds an AI SDK model that
 * dispatches through `env.AI.run` (the resume-capable run path) and reuses the
 * matching `@ai-sdk/*` parser for the response.
 *
 * Two builders mirror the two recovery shapes:
 *  - `buildCaptureModel` — normal turn: capture `cf-aig-run-id` + the live SSE
 *    event offset (for stashing), and wrap the stream so transient drops resume.
 *  - `buildReattachModel` — recovery turn: re-attach to an existing run from a
 *    persisted event offset (no fresh inference, no token spend).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModel } from "ai";
import { createResumableStream, type ResumeFetcher } from "./resume";

interface RunBinding extends ResumeFetcher {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<Response>;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return "{}";
}

function splitSlug(slug: string): { vendor: string; modelId: string } {
  const slash = slug.indexOf("/");
  if (slash === -1)
    throw new Error(`Model slug "${slug}" needs a "<vendor>/<model>" shape.`);
  return { vendor: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}

function buildProvider(
  vendor: string,
  modelId: string,
  fetchImpl: typeof globalThis.fetch
): LanguageModel {
  if (vendor === "openai") {
    return createOpenAI({ apiKey: "unused", fetch: fetchImpl }).chat(modelId);
  }
  if (vendor === "anthropic") {
    return createAnthropic({ apiKey: "unused", fetch: fetchImpl })(modelId);
  }
  throw new Error(
    `gateway-resume demo only wires openai/anthropic, got "${vendor}".`
  );
}

export interface CaptureHooks {
  /** Fired once with the run's `cf-aig-run-id`. */
  onRunId?: (runId: string) => void;
  /** Fired with the cumulative SSE event offset as the stream advances. */
  onProgress?: (eventOffset: number) => void;
}

export interface CaptureModelArgs {
  binding: Ai;
  gateway: string;
  slug: string;
  hooks?: CaptureHooks;
}

export function buildCaptureModel(args: CaptureModelArgs): LanguageModel {
  const { vendor, modelId } = splitSlug(args.slug);
  const ai = args.binding as unknown as RunBinding;

  const runFetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const body = JSON.parse(bodyText(init?.body)) as Record<string, unknown>;
    delete body.model; // the slug carries the model
    const resp = await ai.run(args.slug, body, {
      gateway: { id: args.gateway },
      returnRawResponse: true
    });
    const runId = resp.headers.get("cf-aig-run-id");
    if (runId) args.hooks?.onRunId?.(runId);
    if (!resp.body || !runId) return resp; // resume unavailable — passthrough
    const wrapped = createResumableStream({
      binding: ai,
      gateway: args.gateway,
      runId,
      initial: resp.body,
      ...(args.hooks?.onProgress ? { onProgress: args.hooks.onProgress } : {})
    });
    return new Response(wrapped, {
      status: resp.status,
      headers: resp.headers
    });
  }) as typeof globalThis.fetch;

  return buildProvider(vendor, modelId, runFetch);
}

export interface ReattachModelArgs {
  binding: Ai;
  gateway: string;
  slug: string;
  runId: string;
  fromEvent: number;
}

export function buildReattachModel(args: ReattachModelArgs): LanguageModel {
  const { vendor, modelId } = splitSlug(args.slug);
  const ai = args.binding as unknown as RunBinding;

  const reattachFetch = (async (): Promise<Response> => {
    const stream = createResumableStream({
      binding: ai,
      gateway: args.gateway,
      runId: args.runId,
      fromEvent: args.fromEvent
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof globalThis.fetch;

  return buildProvider(vendor, modelId, reattachFetch);
}

/**
 * Parse a re-attach to TEXT through the provider parser. With `fromEvent: 0`
 * this yields the **full** message the run produced (ground truth for the
 * zero-loss check, since the run is server-driven — it completes regardless of
 * the originating disconnect); with `fromEvent: N` it yields just the tail.
 */
export async function parseReattachText(
  args: ReattachModelArgs
): Promise<string> {
  const model = buildReattachModel(args);
  const result = streamText({ model, prompt: "resume" });
  let text = "";
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += (part as unknown as { text?: string }).text ?? "";
    }
  }
  return text;
}
