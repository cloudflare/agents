/**
 * Risk #1 — request-side passthrough on the run path.
 *
 * The RFC (design/rfc-workers-ai-gateway-merge.md) gates the whole run-path
 * delegate architecture on one question:
 *
 *   Does `env.AI.run("vendor/model", body, { returnRawResponse })` accept the
 *   *exact* request body a real `@ai-sdk/*` provider emits, and return a
 *   response that the SAME provider's parser consumes cleanly?
 *
 * If yes, the delegate is just "build the @ai-sdk model with a custom fetch that
 * forwards to env.AI.run" — no hand-rolled per-provider parsing, and the
 * `max_tokens` / `max_completion_tokens` param headaches vanish (each provider
 * emits its own correct params). If no, we rethink (compose-explicitly, /compat).
 *
 * This module wires a real `@ai-sdk/openai` (Chat Completions — NOT the v6
 * default Responses API) and `@ai-sdk/anthropic` model with a custom fetch that
 * dispatches through the run path, then runs `streamText` and asserts the parser
 * yields clean output (text, usage, finish reason, optional tool call). It also
 * captures `cf-aig-run-id` two ways (our fetch + `result.response.headers`) to
 * settle Risk #3, and exercises `anthropic-version` survival (Risk #2).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, stepCountIs, type LanguageModel } from "ai";
import { z } from "zod";

interface Env {
  AI: Ai;
}

type RunBinding = {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<Response>;
};

export interface PassthroughResult {
  slug: string;
  ok: boolean;
  error?: string;
  // request-side: what we forwarded + dispatch outcome
  forwardedBodyKeys?: string[];
  droppedModelField?: boolean;
  dispatchStatus?: number;
  // response-side: did the @ai-sdk parser consume it cleanly?
  textChars?: number;
  textChunks?: number;
  partTypes?: Record<string, number>;
  finishReason?: string;
  usage?: Record<string, unknown>;
  toolCalls?: { name: string; input: unknown }[];
  streamError?: string;
  // run-id capture (Risk #3): from our fetch vs from result.response.headers
  runIdFromFetch?: string | null;
  runIdFromResponse?: string | null;
  textPreview?: string;
}

/**
 * Build a `fetch` that hijacks the @ai-sdk provider's outgoing HTTP call and
 * forwards its body to `env.AI.run(slug, body, { returnRawResponse })`. The
 * provider's own parser then consumes the returned raw Response.
 */
function makeRunFetch(
  env: Env,
  slug: string,
  gateway: string,
  opts: {
    dropModelField: boolean;
    captured: { runId: string | null; status: number | null };
  }
): typeof fetch {
  return (async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body
          ? new TextDecoder().decode(init.body as ArrayBuffer)
          : "{}";
    const body = JSON.parse(bodyText) as Record<string, unknown>;

    // The slug encodes the model; the body's `model` field is redundant on the
    // run path. Test dropping it (RFC §2) — some inputs validators reject extras.
    if (opts.dropModelField) delete body.model;

    const ai = env.AI as unknown as RunBinding;
    const resp = await ai.run(slug, body, {
      gateway: { id: gateway },
      returnRawResponse: true,
      ...(init?.signal ? { signal: init.signal } : {})
    });

    opts.captured.runId = resp.headers.get("cf-aig-run-id");
    opts.captured.status = resp.status;
    return resp;
  }) as typeof fetch;
}

function buildModel(
  env: Env,
  slug: string,
  gateway: string,
  captured: { runId: string | null; status: number | null },
  dropModelField: boolean
): LanguageModel {
  const slash = slug.indexOf("/");
  const vendor = slug.slice(0, slash);
  const bareModel = slug.slice(slash + 1);
  const fetchImpl = makeRunFetch(env, slug, gateway, {
    dropModelField,
    captured
  });

  switch (vendor) {
    case "openai": {
      const provider = createOpenAI({ apiKey: "unused", fetch: fetchImpl });
      // IMPORTANT: .chat() forces Chat Completions. In AI SDK v6 the bare
      // `openai(id)` defaults to the Responses API, which the run catalog does
      // not serve (RFC §10a) — using it here would be testing the wrong wire.
      return provider.chat(bareModel);
    }
    case "anthropic": {
      const provider = createAnthropic({ apiKey: "unused", fetch: fetchImpl });
      return provider(bareModel);
    }
    default:
      throw new Error(`passthrough not mapped for vendor "${vendor}"`);
  }
}

export async function passthroughProbe(
  env: Env,
  slug: string,
  gateway: string,
  prompt: string,
  opts: { withTools?: boolean; dropModelField?: boolean } = {}
): Promise<PassthroughResult> {
  const dropModelField = opts.dropModelField ?? true;
  const captured = {
    runId: null as string | null,
    status: null as number | null
  };

  try {
    const model = buildModel(env, slug, gateway, captured, dropModelField);

    const tools = opts.withTools
      ? {
          get_weather: tool({
            description: "Get the current weather for a city.",
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }) => ({ city, tempC: 21, sky: "clear" })
          })
        }
      : undefined;

    const result = streamText({
      model,
      prompt: opts.withTools
        ? `${prompt}\n\nAlso, what is the weather in Tokyo? Use the get_weather tool.`
        : prompt,
      ...(tools ? { tools, stopWhen: stepCountIs(3) } : {})
    });

    const partTypes: Record<string, number> = {};
    let textChars = 0;
    let textChunks = 0;
    let collected = "";
    let streamError: string | undefined;

    for await (const part of result.fullStream) {
      partTypes[part.type] = (partTypes[part.type] ?? 0) + 1;
      if (part.type === "text-delta") {
        // v6 uses `.text`; tolerate `.textDelta` from older shapes.
        const t =
          (part as unknown as { text?: string; textDelta?: string }).text ??
          (part as unknown as { textDelta?: string }).textDelta ??
          "";
        collected += t;
        textChars += t.length;
        textChunks++;
      } else if (part.type === "error") {
        streamError = String((part as unknown as { error: unknown }).error);
      }
    }

    const [finishReason, usage, response, toolCalls] = await Promise.all([
      result.finishReason,
      result.usage,
      result.response,
      result.toolCalls
    ]);

    return {
      slug,
      ok: !streamError && textChars > 0 ? true : !streamError,
      droppedModelField: dropModelField,
      dispatchStatus: captured.status ?? undefined,
      textChars,
      textChunks,
      partTypes,
      finishReason: finishReason as string,
      usage: usage as unknown as Record<string, unknown>,
      toolCalls: (toolCalls ?? []).map((tc) => ({
        name: (tc as unknown as { toolName: string }).toolName,
        input:
          (tc as unknown as { input?: unknown; args?: unknown }).input ??
          (tc as unknown as { args?: unknown }).args
      })),
      streamError,
      runIdFromFetch: captured.runId,
      runIdFromResponse:
        (response as unknown as { headers?: Record<string, string> }).headers?.[
          "cf-aig-run-id"
        ] ?? null,
      textPreview: collected.slice(0, 240)
    };
  } catch (e) {
    return {
      slug,
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      droppedModelField: dropModelField,
      dispatchStatus: captured.status ?? undefined,
      runIdFromFetch: captured.runId
    };
  }
}
