/**
 * DEMO MODULE — LanguageModel: Cloudflare AI Gateway, the one that just runs.
 *
 * Plain HTTPS with a gateway token: no Workers runtime, no per-vendor key, no
 * provider file to pass on the command line. The gateway speaks an
 * OpenAI-compatible protocol for every provider slug, so one `@ai-sdk/openai`
 * client reaches all of them — and it arrives at our seam through the same
 * `aiSdkModel()` adapter as any other AI SDK model, which is the point: the
 * whole ecosystem is one adapter among peers.
 *
 * This route streams token deltas AND calls tools, so it is the one that
 * brings the tool-driven strategies to life (tollbooth approvals, the oracle,
 * planner tool use).
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "../../contract.js";
import { aiSdkModel } from "./ai-sdk.js";

const ACCOUNT = "27b146402af2103944379f33841b6234";
const GATEWAY = "project-gateway";
const PROJECT = "agents-team-cls-rebuild-demo";

/** gpt-oss-120b, not llama-3.3-70b: llama streams its tool calls as ordinary
 * content text (zero tool_call deltas over the OpenAI-compatible endpoint),
 * so the agent never sees a call. Verified against the gateway, not assumed. */
const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";

/**
 * Workers AI stops at 256 output tokens unless told otherwise — an answer of
 * any length just stops mid-sentence. Overridable with AI_GATEWAY_MAX_TOKENS.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface AiGatewayOptions {
  /** Gateway provider slug: workers-ai (default), openai, grok, … */
  readonly slug?: string;
  readonly model?: string;
  readonly maxOutputTokens?: number;
}

export function aiGateway(opts: AiGatewayOptions = {}): LanguageModel {
  const token = process.env.AI_GATEWAY_KEY;
  if (token === undefined || token.length === 0) {
    throw new Error(
      "No gateway token: export AI_GATEWAY_KEY (the name the shared direnv " +
        ".envrc uses). There is no fallback model."
    );
  }
  const slug = opts.slug ?? process.env.AI_GATEWAY_SLUG ?? "workers-ai";
  const model = opts.model ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_MODEL;

  const gateway = createOpenAI({
    name: `ai-gateway:${slug}`,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/${GATEWAY}/${slug}/v1`,
    // The client insists on an apiKey, but the upstream key lives in the
    // gateway and auth rides cf-aig-authorization. The gateway FORWARDS an
    // Authorization header verbatim, so a placeholder one is not harmless —
    // it reaches the vendor and comes back 401. Strip it on the way out.
    apiKey: "unused",
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      return fetch(input, { ...init, headers, body: widenNullContent(init) });
    },
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      // Required on every request, by team convention.
      "cf-aig-metadata": JSON.stringify({ project: PROJECT })
    }
  });

  const envMax = Number(process.env.AI_GATEWAY_MAX_TOKENS);
  // .chat() pins the chat-completions API: @ai-sdk/openai v4 would otherwise
  // default to OpenAI's Responses API, which the gateway slugs do not serve.
  return aiSdkModel(gateway.chat(model), {
    maxOutputTokens:
      opts.maxOutputTokens ??
      (Number.isFinite(envMax) && envMax > 0 ? envMax : undefined) ??
      DEFAULT_MAX_OUTPUT_TOKENS
  });
}

/**
 * Workers AI's OpenAI-compatible schema requires message content to be a
 * string, but the AI SDK sends `content: null` on an assistant message that
 * carries only tool calls — legal at OpenAI, a 400 here ("'string' not in
 * 'null'"). Every turn after a tool call would fail. One vendor quirk, fixed
 * at the edge, so no other module has to know.
 */
function widenNullContent(init: RequestInit | undefined): BodyInit | null {
  const body = init?.body ?? null;
  if (typeof body !== "string") return body;
  const parsed = JSON.parse(body) as { messages?: unknown };
  if (!Array.isArray(parsed.messages)) return body;
  parsed.messages = parsed.messages.map((m) => {
    const message = m as { content?: unknown };
    return message.content === null ? { ...message, content: "" } : message;
  });
  return JSON.stringify(parsed);
}
