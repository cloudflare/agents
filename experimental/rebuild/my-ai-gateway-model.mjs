import { createOpenAI } from "@ai-sdk/openai";

// Cloudflare AI Gateway, reached over plain HTTPS with a gateway token — no
// Workers runtime and no per-provider key needed. The gateway speaks an
// OpenAI-compatible protocol for each provider slug, so one @ai-sdk/openai
// client covers all of them; swap AI_GATEWAY_SLUG/AI_GATEWAY_MODEL to point
// this same file at grok or google-ai-studio instead of Workers AI.
//
// Unlike the Codex route this provider streams token deltas AND supports tool
// calls, so the tool-driven strategies (tollbooth approvals, the oracle,
// planner tool use) come alive with it.

const ACCOUNT = "27b146402af2103944379f33841b6234";
const GATEWAY = "project-gateway";
const PROJECT = "agents-team-cls-rebuild-demo";

const token = process.env.AI_GATEWAY_API_KEY ?? process.env.AI_GATEWAY_KEY;
if (token === undefined || token.length === 0) {
  throw new Error(
    "No gateway token: set AI_GATEWAY_API_KEY (or AI_GATEWAY_KEY). Put it in " +
      "experimental/rebuild/.env (git-ignored; the demo script loads it), or " +
      "export it — direnv's shared .envrc already defines AI_GATEWAY_KEY."
  );
}

const slug = process.env.AI_GATEWAY_SLUG ?? "workers-ai";
// gpt-oss-120b, not llama-3.3-70b: llama streams its tool calls as ordinary
// content text (zero tool_call deltas over the OpenAI-compatible endpoint),
// so the agent would never see a tool call. gpt-oss-120b streams them
// properly. Verified against the gateway, not assumed.
const modelId = process.env.AI_GATEWAY_MODEL ?? "@cf/openai/gpt-oss-120b";

const gateway = createOpenAI({
  name: `ai-gateway:${slug}`,
  baseURL: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/${GATEWAY}/${slug}/v1`,
  // The @ai-sdk client insists on an apiKey, but the upstream key lives in
  // the gateway and auth rides cf-aig-authorization. The gateway FORWARDS an
  // Authorization header verbatim, so a placeholder one is not harmless — it
  // reaches the vendor and comes back 401. Strip it on the way out.
  apiKey: "unused",
  fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return fetch(input, { ...init, headers, body: patchBody(init?.body) });
  },
  headers: {
    "cf-aig-authorization": `Bearer ${token}`,
    // Required on every request, by team convention.
    "cf-aig-metadata": JSON.stringify({ project: PROJECT })
  }
});

/**
 * Workers AI's OpenAI-compatible schema requires message content to be a
 * string, but the AI SDK sends `content: null` on an assistant message that
 * carries only tool calls — legal at OpenAI, a 400 here ("'string' not in
 * 'null'"). Every turn after a tool call would fail. One vendor quirk, fixed
 * at the composition edge where it belongs, so no demo module has to know.
 */
function patchBody(body) {
  if (typeof body !== "string") return body;
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed.messages)) return body;
  parsed.messages = parsed.messages.map((m) =>
    m.content === null ? { ...m, content: "" } : m
  );
  return JSON.stringify(parsed);
}

// .chat() pins the chat-completions API: @ai-sdk/openai v4 would otherwise
// default to OpenAI's Responses API, which the gateway slugs do not serve.
export default gateway.chat(modelId);
