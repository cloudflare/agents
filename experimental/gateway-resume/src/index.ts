/**
 * Gateway Resume Harness — verify AI Gateway native resumable streaming.
 *
 * Background
 * ----------
 * AI Gateway buffers streaming inference responses durably and stamps each
 * run with a `cf-aig-run-id` header. A dropped consumer can reconnect and
 * replay from an offset via:
 *
 *   GET https://workers-binding.ai/ai-gateway/gateways/{gateway}/run/{runId}/resume?from={n}
 *
 * This is the native version of what experimental/inference-buffer prototypes
 * (RFC #1257). This harness verifies the contract empirically, across models,
 * including OpenAI/Anthropic models routed through Workers AI on unified
 * billing (see https://blog.cloudflare.com/ai-platform/).
 *
 * What it checks
 * --------------
 * For each model:
 *   1. start a streaming run via the AI binding with `returnRawResponse: true`
 *      and `gateway: { id }`, capturing `cf-aig-run-id`.
 *   2. fully drain the stream into raw bytes, recording SSE event boundaries.
 *   3. resume the SAME run id from a midpoint and assert the replayed bytes
 *      equal the tail of the full stream (the core resume invariant — same
 *      run, so the buffer is byte-deterministic).
 *   4. detect whether `from` is a BYTE offset or an SSE-EVENT index by trying
 *      both candidate values and seeing which yields a clean tail match.
 *
 * Endpoints
 * ---------
 *   GET /                       — HTML report over the default model matrix
 *   GET /probe?model=...        — single-model JSON report (the core test)
 *   GET /matrix?models=a,b,c    — JSON report across models (comma-separated)
 *   GET /run?model=...          — raw single run metadata (run id, headers, preview)
 *   GET /resume?runId=..&from=N — passthrough to the gateway resume endpoint
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModel } from "ai";
import {
  buildDelegateModel,
  DelegateError,
  type DelegateOptions
} from "./delegate";
import { passthroughProbe, type PassthroughResult } from "./passthrough";
import { createResumableStream, ResumeExpiredError } from "./resumable";

interface Env {
  AI: Ai;
}

// env.AI.fetch() exists at runtime (workerd ai-api.ts) but isn't in the
// generated Ai type. This is the internal binding fetch used to reach the
// gateway resume endpoint.
type AiWithFetch = Ai & {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

const DEFAULT_GATEWAY = "default";
const DEFAULT_PROMPT =
  "Write a vivid 120-word description of a thunderstorm rolling over a city at night. Use concrete sensory detail.";

// Models to exercise.
//
// Resumable streaming (cf-aig-run-id + /resume) works only for dash-catalog
// (third-party) models on AI Gateway's new run API. Workers AI (@cf/*) models
// are NOT on the run API yet, so they get no run-id (included here to show the
// gap). Anthropic/xAI need BYOK on this account (unified billing currently
// covers OpenAI + Google), so they're omitted from the default set — pass them
// via ?models= once keys are configured. Per-model failures are reported, not
// fatal, so the matrix still renders.
const DEFAULT_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "google/gemini-2.5-flash",
  "anthropic/claude-opus-4.7",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
];

// ---------------------------------------------------------------------------
// Byte / SSE helpers
// ---------------------------------------------------------------------------

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

/**
 * Find the start byte offset of each SSE event (events are separated by a
 * blank line: "\n\n"). Returns the offset of the first byte of each event.
 */
function sseEventOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [0];
  // Look for "\n\n" (0x0a 0x0a). The byte AFTER the separator starts the next event.
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      const next = i + 2;
      if (next < bytes.length) offsets.push(next);
    }
  }
  return offsets;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** First index where two arrays diverge, or -1 if one is a prefix of the other. */
function firstDivergence(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const td = new TextDecoder();
function preview(bytes: Uint8Array, max = 240): string {
  return td.decode(bytes.slice(0, max));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Count complete SSE events (terminated by a blank line) in `bytes`. */
function countSseEvents(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      n++;
      i++;
    }
  }
  return n;
}

/** Whether the stream carries its provider-native terminator (run completed). */
function hasTerminalEvent(bytes: Uint8Array, model: string): boolean {
  const text = td.decode(bytes);
  if (model.startsWith("anthropic/")) return text.includes("message_stop");
  // openai (and most others routed through the run API) end with `data: [DONE]`.
  return text.includes("[DONE]");
}

/**
 * Read up to `k` complete SSE events from `body`, then CANCEL the reader to
 * simulate the originating request disconnecting mid-stream. Returns how much we
 * consumed before cancelling.
 */
async function readSomeThenCancel(
  body: ReadableStream<Uint8Array>,
  k: number
): Promise<{ readEvents: number; readBytes: number }> {
  const reader = body.getReader();
  let events = 0;
  let bytes = 0;
  let buf = "";
  try {
    while (events < k) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        bytes += value.length;
        buf += td.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          events++;
          buf = buf.slice(idx + 2);
          if (events >= k) break;
        }
      }
    }
  } finally {
    // cancel() releases the upstream subrequest — the gateway sees us disconnect.
    await reader.cancel("detach-probe").catch(() => {});
  }
  return { readEvents: events, readBytes: bytes };
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

interface FullRun {
  runId: string | null;
  status: number;
  contentType: string | null;
  interestingHeaders: Record<string, string>;
  bytes: Uint8Array;
  eventOffsets: number[];
}

const INTERESTING_HEADER_PREFIXES = ["cf-aig-", "cf-ray", "content-type"];

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (INTERESTING_HEADER_PREFIXES.some((p) => lk.startsWith(p))) out[lk] = v;
  }
  return out;
}

async function startRun(
  env: Env,
  model: string,
  gateway: string,
  prompt: string,
  extraHeaders?: Record<string, string>
): Promise<FullRun> {
  // The universal /ai/run endpoint passes the PROVIDER-NATIVE request schema
  // through — it does not normalize params. Anthropic *requires* `max_tokens`;
  // OpenAI gpt-5* *rejects* `max_tokens` and wants `max_completion_tokens`.
  // So the token-limit param is provider-specific.
  const tokenParam: Record<string, number> = model.startsWith("anthropic/")
    ? { max_tokens: 1024 }
    : model.startsWith("openai/")
      ? { max_completion_tokens: 1024 }
      : {};

  // The binding's run() is heavily overloaded; for the raw-response streaming
  // path we narrow to a signature that returns a Response. Call it as a METHOD
  // on env.AI — extracting it into a bare variable detaches `this`, and the
  // binding internally touches `this.#options` (private field), which throws
  // "Cannot set properties of undefined (setting '#options')".
  const ai = env.AI as unknown as {
    run(
      model: string,
      inputs: Record<string, unknown>,
      options: Record<string, unknown>
    ): Promise<Response>;
  };

  const response = await ai.run(
    model,
    {
      stream: true,
      ...tokenParam,
      messages: [{ role: "user", content: prompt }]
    },
    {
      gateway: { id: gateway },
      returnRawResponse: true,
      ...(extraHeaders ? { extraHeaders } : {})
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(`run failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const runId =
    response.headers.get("cf-aig-run-id") ??
    response.headers.get("cf-aig-run-id".toUpperCase());

  const bytes = response.body ? await drain(response.body) : new Uint8Array(0);

  return {
    runId,
    status: response.status,
    contentType: response.headers.get("content-type"),
    interestingHeaders: collectHeaders(response.headers),
    bytes,
    eventOffsets: sseEventOffsets(bytes)
  };
}

async function resume(
  env: Env,
  gateway: string,
  runId: string,
  from: number | string
): Promise<{
  status: number;
  bytes: Uint8Array;
  headers: Record<string, string>;
}> {
  const ai = env.AI as AiWithFetch;
  const url = `https://workers-binding.ai/ai-gateway/gateways/${gateway}/run/${runId}/resume?from=${from}`;
  const res = await ai.fetch(url, { method: "GET" });
  const bytes = res.body ? await drain(res.body) : new Uint8Array(0);
  return { status: res.status, bytes, headers: collectHeaders(res.headers) };
}

// ---------------------------------------------------------------------------
// Gateway-binding transport (the path ai-gateway-provider / PR #409 uses)
//
// Instead of env.AI.run("openai/gpt-5.4", inputs), dispatch the PROVIDER-NATIVE
// request through the AI Gateway universal endpoint as a single-entry array:
//
//   env.AI.gateway(id).run([{ provider, endpoint, headers, query }])
//
// This is the only transport that supports server-side fallback (array of N +
// cf-aig-step). The open question this probes: does THIS path also stamp
// `cf-aig-run-id` and support /resume the way the env.AI.run path does?
// ---------------------------------------------------------------------------

interface GatewayEntry {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
}

/**
 * Build a provider-native gateway entry for a `vendor/model` slug. Endpoints
 * mirror PR #409's `transformEndpoint` output (provider host prefix stripped).
 */
function gatewayEntry(
  model: string,
  prompt: string,
  extraHeaders?: Record<string, string>
): GatewayEntry {
  const slash = model.indexOf("/");
  const vendor = model.slice(0, slash);
  const bareModel = model.slice(slash + 1);
  const messages = [{ role: "user", content: prompt }];
  const headers = { "Content-Type": "application/json", ...extraHeaders };

  switch (vendor) {
    case "openai":
      return {
        provider: "openai",
        endpoint: "v1/chat/completions",
        headers,
        query: {
          model: bareModel,
          stream: true,
          max_completion_tokens: 1024,
          messages
        }
      };
    case "anthropic":
      return {
        provider: "anthropic",
        endpoint: "v1/messages",
        headers: { "anthropic-version": "2023-06-01", ...headers },
        query: { model: bareModel, stream: true, max_tokens: 1024, messages }
      };
    case "google":
      return {
        provider: "google-ai-studio",
        endpoint: `v1beta/models/${bareModel}:streamGenerateContent?alt=sse`,
        headers,
        query: { contents: [{ role: "user", parts: [{ text: prompt }] }] }
      };
    default:
      throw new Error(`gateway-path entry not mapped for vendor "${vendor}"`);
  }
}

async function startRunViaGateway(
  env: Env,
  model: string,
  gateway: string,
  prompt: string,
  extraHeaders?: Record<string, string>
): Promise<FullRun> {
  const entry = gatewayEntry(model, prompt, extraHeaders);

  // env.AI.gateway(id) returns an AiGateway whose run() takes the universal
  // request (array for fallback) and returns the raw upstream Response. Not in
  // the generated types in a usable streaming shape, so narrow it. Call as a
  // METHOD to preserve `this` (see the env.AI.run footgun above).
  const aiWithGateway = env.AI as unknown as {
    gateway(id: string): {
      run(body: unknown, options?: Record<string, unknown>): Promise<Response>;
    };
  };
  const gw = aiWithGateway.gateway(gateway);
  const response = await gw.run([entry]);

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `gateway run failed (${response.status}): ${text.slice(0, 500)}`
    );
  }

  const runId = response.headers.get("cf-aig-run-id");
  const bytes = response.body ? await drain(response.body) : new Uint8Array(0);

  return {
    runId,
    status: response.status,
    contentType: response.headers.get("content-type"),
    interestingHeaders: collectHeaders(response.headers),
    bytes,
    eventOffsets: sseEventOffsets(bytes)
  };
}

/**
 * Gateway-path dispatch with an ARRAY of entries — exercises server-side
 * fallback (Risk #6). The gateway tries entries in order; `cf-aig-step` reports
 * which index served. Pass a bad model first to force a fallback step.
 */
async function runGatewayArray(
  env: Env,
  models: string[],
  gateway: string,
  prompt: string,
  entryHeaders?: Record<string, string>
): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bytes: number;
  preview: string;
}> {
  const entries = models.map((m) => gatewayEntry(m, prompt, entryHeaders));
  const aiWithGateway = env.AI as unknown as {
    gateway(id: string): {
      run(body: unknown, options?: Record<string, unknown>): Promise<Response>;
    };
  };
  const gw = aiWithGateway.gateway(gateway);
  const response = await gw.run(entries);
  const bytes = response.body ? await drain(response.body) : new Uint8Array(0);
  return {
    status: response.status,
    ok: response.ok,
    headers: collectHeaders(response.headers),
    bytes: bytes.length,
    preview: preview(bytes, 200)
  };
}

// ---------------------------------------------------------------------------
// Probe — the full deterministic resume verification for one model
// ---------------------------------------------------------------------------

type FromSemantics = "byte-offset" | "event-index" | "unknown";

interface ProbeResult {
  model: string;
  ok: boolean;
  error?: string;
  runId?: string | null;
  hasRunId?: boolean;
  status?: number;
  contentType?: string | null;
  totalBytes?: number;
  eventCount?: number;
  headers?: Record<string, string>;
  // resume from=0 should reproduce the entire stream
  resumeFromZero?: {
    status: number;
    bytes: number;
    matchesFull: boolean;
    firstDivergence: number;
  };
  // resume from a midpoint, tried as both event index and byte offset
  midEventIndex?: number;
  midByteOffset?: number;
  resumeAsEventIndex?: { status: number; bytes: number; matchesTail: boolean };
  resumeAsByteOffset?: { status: number; bytes: number; matchesTail: boolean };
  fromSemantics?: FromSemantics;
  previewHead?: string;
}

type StartFn = (
  env: Env,
  model: string,
  gateway: string,
  prompt: string,
  extraHeaders?: Record<string, string>
) => Promise<FullRun>;

async function probe(
  env: Env,
  model: string,
  gateway: string,
  prompt: string,
  start: StartFn = startRun
): Promise<ProbeResult> {
  try {
    const full = await start(env, model, gateway, prompt);

    const base: ProbeResult = {
      model,
      ok: true,
      runId: full.runId,
      hasRunId: !!full.runId,
      status: full.status,
      contentType: full.contentType,
      totalBytes: full.bytes.length,
      eventCount: full.eventOffsets.length,
      headers: full.interestingHeaders,
      previewHead: preview(full.bytes)
    };

    if (!full.runId) {
      return {
        ...base,
        ok: false,
        error:
          "No cf-aig-run-id header on the response — resume not available for this run/gateway/model."
      };
    }

    const midEventIndex = Math.floor(full.eventOffsets.length / 2);
    const midByteOffset = full.eventOffsets[midEventIndex] ?? 0;
    const tail = full.bytes.slice(midByteOffset);

    const r0 = await resume(env, gateway, full.runId, 0);
    const rEvent = await resume(env, gateway, full.runId, midEventIndex);
    const rByte = await resume(env, gateway, full.runId, midByteOffset);

    const eventMatches = bytesEqual(rEvent.bytes, tail);
    const byteMatches = bytesEqual(rByte.bytes, tail);

    let fromSemantics: FromSemantics = "unknown";
    if (eventMatches && !byteMatches) fromSemantics = "event-index";
    else if (byteMatches && !eventMatches) fromSemantics = "byte-offset";
    // If both/neither match, leave "unknown" — inspect the raw numbers.

    return {
      ...base,
      resumeFromZero: {
        status: r0.status,
        bytes: r0.bytes.length,
        matchesFull: bytesEqual(r0.bytes, full.bytes),
        firstDivergence: firstDivergence(r0.bytes, full.bytes)
      },
      midEventIndex,
      midByteOffset,
      resumeAsEventIndex: {
        status: rEvent.status,
        bytes: rEvent.bytes.length,
        matchesTail: eventMatches
      },
      resumeAsByteOffset: {
        status: rByte.status,
        bytes: rByte.bytes.length,
        matchesTail: byteMatches
      },
      fromSemantics
    };
  } catch (e) {
    return {
      model,
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(results: ProbeResult[], gateway: string): string {
  const rows = results
    .map((r) => {
      if (!r.ok) {
        return `<tr class="bad">
          <td>${escapeHtml(r.model)}</td>
          <td colspan="6">${escapeHtml(r.error ?? "failed")}</td>
        </tr>`;
      }
      const zero = r.resumeFromZero;
      const ev = r.resumeAsEventIndex;
      const by = r.resumeAsByteOffset;
      const verdict =
        zero?.matchesFull && (ev?.matchesTail || by?.matchesTail)
          ? "ok"
          : "warn";
      return `<tr class="${verdict}">
        <td>${escapeHtml(r.model)}</td>
        <td>${r.hasRunId ? "yes" : "<b>no</b>"}</td>
        <td>${r.totalBytes} B / ${r.eventCount} ev</td>
        <td>${zero ? (zero.matchesFull ? "match" : `diff@${zero.firstDivergence}`) : "-"}</td>
        <td>${ev ? (ev.matchesTail ? "match" : `${ev.bytes}B`) : "-"}</td>
        <td>${by ? (by.matchesTail ? "match" : `${by.bytes}B`) : "-"}</td>
        <td><b>${r.fromSemantics ?? "-"}</b></td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Gateway Resume Harness</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem; color: #111; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
  tr.ok td:first-child { border-left: 4px solid #2e7d32; }
  tr.warn td:first-child { border-left: 4px solid #ed6c02; }
  tr.bad td:first-child { border-left: 4px solid #c62828; }
  .meta { color: #666; }
</style></head>
<body>
<h1>AI Gateway native resume — model matrix</h1>
<p class="meta">gateway: <code>${escapeHtml(gateway)}</code> ·
resume invariant: <code>resume(from=mid) === full.slice(mid)</code> ·
<a href="/matrix">JSON</a></p>
<table>
<thead><tr>
  <th>model</th><th>run-id?</th><th>full</th>
  <th>resume from=0</th><th>from=eventIdx</th><th>from=byteOff</th><th>from semantics</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="meta">Per-model detail: <code>/probe?model=&lt;slug&gt;</code></p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const gateway = url.searchParams.get("gateway") ?? DEFAULT_GATEWAY;
    const prompt = url.searchParams.get("prompt") ?? DEFAULT_PROMPT;

    switch (url.pathname) {
      case "/": {
        const results: ProbeResult[] = [];
        for (const model of DEFAULT_MODELS) {
          results.push(await probe(env, model, gateway, prompt));
        }
        return new Response(renderHtml(results, gateway), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      case "/probe": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);
        const result = await probe(env, model, gateway, prompt);
        return Response.json(result);
      }

      case "/matrix": {
        const models =
          url.searchParams
            .get("models")
            ?.split(",")
            .map((m) => m.trim()) ?? DEFAULT_MODELS;
        const results: ProbeResult[] = [];
        for (const model of models) {
          results.push(await probe(env, model, gateway, prompt));
        }
        return Response.json({ gateway, prompt, results });
      }

      // Gateway-binding transport probe — does env.AI.gateway(id).run([...])
      // stamp cf-aig-run-id + support /resume? (The Risk #1 experiment.)
      case "/gw": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);
        const result = await probe(
          env,
          model,
          gateway,
          prompt,
          startRunViaGateway
        );
        return Response.json({ transport: "gateway-binding", ...result });
      }

      case "/gw-matrix": {
        const models =
          url.searchParams
            .get("models")
            ?.split(",")
            .map((m) => m.trim()) ??
          DEFAULT_MODELS.filter((m) => !m.startsWith("@cf/"));
        const results: ProbeResult[] = [];
        for (const model of models) {
          results.push(
            await probe(env, model, gateway, prompt, startRunViaGateway)
          );
        }
        return Response.json({
          transport: "gateway-binding",
          gateway,
          prompt,
          results
        });
      }

      // Risk #1 — request-side passthrough: feed a REAL @ai-sdk/* body through
      // env.AI.run and confirm the provider's own parser consumes the response.
      //   ?model=openai/gpt-5.4 [&tools=1] [&keepModel=1]
      case "/passthrough": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);
        const result = await passthroughProbe(env, model, gateway, prompt, {
          withTools: url.searchParams.get("tools") === "1",
          dropModelField: url.searchParams.get("keepModel") !== "1"
        });
        return Response.json(result);
      }

      case "/passthrough-matrix": {
        const models =
          url.searchParams
            .get("models")
            ?.split(",")
            .map((m) => m.trim()) ??
          DEFAULT_MODELS.filter(
            (m) => m.startsWith("openai/") || m.startsWith("anthropic/")
          );
        const withTools = url.searchParams.get("tools") === "1";
        const dropModelField = url.searchParams.get("keepModel") !== "1";
        const results: PassthroughResult[] = [];
        for (const model of models) {
          results.push(
            await passthroughProbe(env, model, gateway, prompt, {
              withTools,
              dropModelField
            })
          );
        }
        return Response.json({
          experiment: "request-side-passthrough",
          gateway,
          results
        });
      }

      // Delegate engine (RFC §1-§4) — exercises capability-driven transport
      // selection end-to-end through the real @ai-sdk parser.
      //   ?model=openai/gpt-5.4
      //   &resume=false                       force resume off
      //   &fallback=server:openai/gpt-5.4-mini  server fallback (gateway path)
      //   &fallback=client:openai/gpt-5.4-mini  client fallback (stays run path)
      //   &cacheTtl=3600                      caching (gateway path)
      //   &transport=run|gateway              escape hatch
      case "/delegate": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);

        const opts: DelegateOptions = { gateway };
        const resumeParam = url.searchParams.get("resume");
        if (resumeParam === "false") opts.resume = false;
        if (resumeParam === "true") opts.resume = true;
        const fbParam = url.searchParams.get("fallback");
        if (fbParam) {
          const [mode, list] = fbParam.split(":");
          opts.fallback = {
            mode: mode === "server" ? "server" : "client",
            models: (list ?? "")
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          };
        }
        const cacheTtl = url.searchParams.get("cacheTtl");
        if (cacheTtl) opts.cacheTtl = Number(cacheTtl);
        const transport = url.searchParams.get("transport");
        if (transport === "run" || transport === "gateway")
          opts.transport = transport;

        try {
          const { model: delegateModel, capture } = buildDelegateModel(
            env,
            model,
            opts
          );
          const result = streamText({ model: delegateModel, prompt });
          const partTypes: Record<string, number> = {};
          let textChars = 0;
          let streamError: string | undefined;
          for await (const part of result.fullStream) {
            partTypes[part.type] = (partTypes[part.type] ?? 0) + 1;
            if (part.type === "text-delta") {
              textChars +=
                (part as unknown as { text?: string }).text?.length ?? 0;
            } else if (part.type === "error") {
              streamError = String(
                (part as unknown as { error: unknown }).error
              );
            }
          }
          const [finishReason, usage] = await Promise.all([
            result.finishReason,
            result.usage
          ]);
          return Response.json({
            slug: model,
            requested: opts,
            transport: capture.transport,
            resumeEnabled: capture.resumeEnabled,
            warnings: capture.warnings,
            dispatch: {
              status: capture.status,
              runId: capture.runId,
              cfStep: capture.cfStep,
              cacheStatus: capture.cacheStatus,
              logId: capture.logId
            },
            output: { textChars, finishReason, partTypes, usage, streamError }
          });
        } catch (e) {
          if (e instanceof DelegateError) {
            return Response.json(
              {
                slug: model,
                requested: opts,
                error: { kind: e.kind, message: e.message }
              },
              { status: 400 }
            );
          }
          return jsonError(e instanceof Error ? e.message : String(e), 502);
        }
      }

      // Resume reconnect/replay layer (RFC §7.1) — run streamText through a
      // run-path model whose body is wrapped in a self-healing resumable stream.
      // ?model=openai/gpt-5.4 [&dropAfter=N] simulates a mid-stream drop after N
      // SSE events and verifies the @ai-sdk parser still produces complete output.
      case "/resume-stream": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);
        const dropParam = url.searchParams.get("dropAfter");
        const dropAfterEvents = dropParam ? Number(dropParam) : undefined;

        const slash = model.indexOf("/");
        const vendor = model.slice(0, slash);
        const bareModel = model.slice(slash + 1);

        let runId: string | null = null;
        let reconnects = 0;
        let expired = false;

        const runFetch = (async (
          _input: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> => {
          const bodyText =
            typeof init?.body === "string"
              ? init.body
              : init?.body
                ? td.decode(init.body as ArrayBuffer)
                : "{}";
          const body = JSON.parse(bodyText) as Record<string, unknown>;
          delete body.model;
          const ai = env.AI as unknown as {
            run(
              m: string,
              i: Record<string, unknown>,
              o: Record<string, unknown>
            ): Promise<Response>;
          };
          const resp = await ai.run(model, body, {
            gateway: { id: gateway },
            returnRawResponse: true
          });
          runId = resp.headers.get("cf-aig-run-id");
          if (!resp.body || !runId) return resp; // resume unavailable — passthrough
          const wrapped = createResumableStream({
            env,
            gateway,
            runId,
            initial: resp.body,
            dropAfterEvents,
            hooks: {
              onReconnect: () => {
                reconnects++;
              },
              onExpired: () => {
                expired = true;
              }
            }
          });
          return new Response(wrapped, {
            status: resp.status,
            headers: resp.headers
          });
        }) as typeof globalThis.fetch;

        let delegateModel: LanguageModel;
        if (vendor === "openai") {
          delegateModel = createOpenAI({
            apiKey: "unused",
            fetch: runFetch
          }).chat(bareModel);
        } else if (vendor === "anthropic") {
          delegateModel = createAnthropic({
            apiKey: "unused",
            fetch: runFetch
          })(bareModel);
        } else {
          return jsonError(
            `resume-stream not mapped for vendor "${vendor}"`,
            400
          );
        }

        const partTypes: Record<string, number> = {};
        let textChars = 0;
        let streamError: string | undefined;
        try {
          const result = streamText({ model: delegateModel, prompt });
          for await (const part of result.fullStream) {
            partTypes[part.type] = (partTypes[part.type] ?? 0) + 1;
            if (part.type === "text-delta") {
              textChars +=
                (part as unknown as { text?: string }).text?.length ?? 0;
            } else if (part.type === "error") {
              streamError = String(
                (part as unknown as { error: unknown }).error
              );
            }
          }
          const finishReason = await result.finishReason;
          return Response.json({
            experiment: "resumable-stream",
            model,
            dropAfterEvents: dropAfterEvents ?? null,
            runId,
            reconnects,
            expired,
            output: { textChars, finishReason, partTypes, streamError }
          });
        } catch (e) {
          return Response.json({
            experiment: "resumable-stream",
            model,
            dropAfterEvents: dropAfterEvents ?? null,
            runId,
            reconnects,
            expired,
            error:
              e instanceof ResumeExpiredError
                ? { kind: "resume-expired", message: e.message }
                : {
                    kind: "unknown",
                    message: e instanceof Error ? e.message : String(e)
                  }
          });
        }
      }

      // Detachment probe — does the gateway KEEP GENERATING after the
      // originating request disconnects mid-stream? Read a few events, cancel
      // the reader (simulating disconnect), then sample resume?from=0 over time.
      // If the event count GROWS after the cancel and/or a terminal event
      // appears, generation continued server-side (the run is "detached"). If it
      // plateaus at the cancel point with no terminal, generation halted.
      case "/detach": {
        const model = url.searchParams.get("model") ?? DEFAULT_MODELS[0];
        const k = Number(url.searchParams.get("k") ?? "3");
        const waits = (url.searchParams.get("waits") ?? "0,4000,10000,20000")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));

        // Start a run with a long prompt so generation lasts long enough to
        // observe; capture run-id from the raw response.
        const longPrompt =
          "Write an exhaustive 2500-word technical essay about distributed " +
          "systems consistency models. Cover linearizability, sequential " +
          "consistency, causal consistency, eventual consistency, CRDTs, " +
          "consensus (Paxos, Raft), and real-world tradeoffs. Be thorough.";
        const ai = env.AI as unknown as {
          run(
            model: string,
            inputs: Record<string, unknown>,
            options: Record<string, unknown>
          ): Promise<Response>;
        };
        const maxTokens = Number(url.searchParams.get("maxTokens") ?? "1024");
        const tokenParam: Record<string, number> = model.startsWith(
          "anthropic/"
        )
          ? { max_tokens: maxTokens }
          : { max_completion_tokens: maxTokens };
        const resp = await ai.run(
          model,
          {
            stream: true,
            ...tokenParam,
            messages: [{ role: "user", content: longPrompt }]
          },
          { gateway: { id: gateway }, returnRawResponse: true }
        );
        const runId = resp.headers.get("cf-aig-run-id");
        if (!resp.body || !runId) {
          return Response.json(
            { experiment: "detach", model, error: "no body or cf-aig-run-id" },
            { status: 502 }
          );
        }

        // Consume k events, then disconnect.
        const consumed = await readSomeThenCancel(resp.body, k);
        const cancelledAt = Date.now();

        // Sample the resume buffer at increasing offsets-from-cancel. Each
        // resume?from=0 fully drains whatever the buffer yields at that moment.
        const samples: Array<{
          atMs: number;
          drainMs: number;
          status: number;
          events: number;
          bytes: number;
          terminal: boolean;
        }> = [];
        let prev = 0;
        for (const w of waits) {
          if (w > prev) await sleep(w - prev);
          prev = w;
          const t0 = Date.now();
          const r = await resume(env, gateway, runId, 0);
          samples.push({
            atMs: Date.now() - cancelledAt,
            drainMs: Date.now() - t0,
            status: r.status,
            events: countSseEvents(r.bytes),
            bytes: r.bytes.length,
            terminal: hasTerminalEvent(r.bytes, model)
          });
        }

        // Verdict. The decisive signals that generation continued AFTER our
        // disconnect (rather than the run being tied to the originating request):
        //   - the first resume BLOCKED while tailing live generation (drainMs
        //     much larger than the trivially-buffered later samples), and/or
        //   - the buffer holds far MORE events than we read before cancelling.
        const first = samples[0];
        const last = samples[samples.length - 1];
        const completed = samples.some((s) => s.terminal);
        const tailedLive = first.drainMs > 1500;
        const exceedsRead = first.events > consumed.readEvents * 3 + 5;
        const grewAcrossSamples = last.events > first.events;

        let verdict: string;
        if (completed && (tailedLive || exceedsRead)) {
          verdict =
            "KEEPS GENERATING TO COMPLETION — generation continued after the " +
            "disconnect and reached its terminal event; resume tails the live run.";
        } else if (tailedLive || exceedsRead || grewAcrossSamples) {
          verdict =
            "KEEPS GENERATING — generation continued after the disconnect " +
            `(buffer reached ${last.events} events vs ${consumed.readEvents} read; ` +
            `first resume tailed for ${first.drainMs}ms)` +
            (completed
              ? " and completed"
              : " but no terminal event was buffered") +
            ".";
        } else {
          verdict =
            "HALTS — the buffer plateaued near the disconnect point; generation " +
            "appears tied to the originating request.";
        }

        return Response.json({
          experiment: "detach",
          model,
          maxTokens,
          runId,
          readBeforeCancel: consumed,
          samples,
          terminalObserved: completed,
          verdict
        });
      }

      // Cross-invocation re-attach (RFC §7.1 / §9) — simulate "invocation #1"
      // starting a run, then "invocation #2 after eviction" re-attaching with NO
      // initial body via createResumableStream({ fromEvent }). Verifies (a) from=0
      // reproduces the full response through the @ai-sdk parser, and (b) from=mid
      // is byte-exact against the known tail.
      case "/reattach": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);

        // Invocation #1: start the run, learn its run-id + event count.
        const run = await startRun(env, model, gateway, prompt);
        if (!run.runId) {
          return Response.json(
            { experiment: "reattach", model, error: "no cf-aig-run-id" },
            {
              status: 502
            }
          );
        }
        const totalEvents = run.eventOffsets.length;
        const midEvent = Math.floor(totalEvents / 2);

        // (a) Invocation #2a: re-attach from 0 and parse through @ai-sdk.
        const slash = model.indexOf("/");
        const vendor = model.slice(0, slash);
        const bareModel = model.slice(slash + 1);
        const reattachFetch = (
          _input: RequestInfo | URL,
          _init?: RequestInit
        ): Promise<Response> => {
          const stream = createResumableStream({
            env,
            gateway,
            runId: run.runId as string,
            fromEvent: 0
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            })
          );
        };

        let parseChars = 0;
        let parseFinish: string | undefined;
        let parseError: string | undefined;
        try {
          let delegateModel: LanguageModel;
          if (vendor === "openai") {
            delegateModel = createOpenAI({
              apiKey: "unused",
              fetch: reattachFetch as typeof globalThis.fetch
            }).chat(bareModel);
          } else if (vendor === "anthropic") {
            delegateModel = createAnthropic({
              apiKey: "unused",
              fetch: reattachFetch as typeof globalThis.fetch
            })(bareModel);
          } else {
            return jsonError(`reattach not mapped for vendor "${vendor}"`, 400);
          }
          const result = streamText({ model: delegateModel, prompt });
          for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
              parseChars +=
                (part as unknown as { text?: string }).text?.length ?? 0;
            } else if (part.type === "error") {
              parseError = String(
                (part as unknown as { error: unknown }).error
              );
            }
          }
          parseFinish = await result.finishReason;
        } catch (e) {
          parseError = e instanceof Error ? e.message : String(e);
        }

        // (b) Invocation #2b: re-attach from a mid offset and compare bytes to the
        // known tail (alignment proof, no parser fragility on a mid-stream start).
        const midStream = createResumableStream({
          env,
          gateway,
          runId: run.runId,
          fromEvent: midEvent
        });
        const midBytes = await drain(midStream);
        const expectedTail = run.bytes.slice(
          run.eventOffsets[midEvent] ?? run.bytes.length
        );
        const tailByteExact = bytesEqual(midBytes, expectedTail);

        // (c) Parse the mid re-attach through @ai-sdk — measures how lossy a
        // mid-stream START is for the provider parser (the stream begins at a
        // bare delta with no `role`/`message_start`), vs the from=0 parse above.
        let midParseChars = 0;
        let midParseFinish: string | undefined;
        let midParseError: string | undefined;
        try {
          const midFetch = (
            _i: RequestInfo | URL,
            _x?: RequestInit
          ): Promise<Response> =>
            Promise.resolve(
              new Response(
                createResumableStream({
                  env,
                  gateway,
                  runId: run.runId as string,
                  fromEvent: midEvent
                }),
                {
                  status: 200,
                  headers: { "content-type": "text/event-stream" }
                }
              )
            );
          const midModel: LanguageModel =
            vendor === "openai"
              ? createOpenAI({
                  apiKey: "unused",
                  fetch: midFetch as typeof globalThis.fetch
                }).chat(bareModel)
              : createAnthropic({
                  apiKey: "unused",
                  fetch: midFetch as typeof globalThis.fetch
                })(bareModel);
          const midResult = streamText({ model: midModel, prompt });
          for await (const part of midResult.fullStream) {
            if (part.type === "text-delta") {
              midParseChars +=
                (part as unknown as { text?: string }).text?.length ?? 0;
            } else if (part.type === "error") {
              midParseError = String(
                (part as unknown as { error: unknown }).error
              );
            }
          }
          midParseFinish = await midResult.finishReason;
        } catch (e) {
          midParseError = e instanceof Error ? e.message : String(e);
        }

        return Response.json({
          experiment: "reattach",
          model,
          runId: run.runId,
          totalEvents,
          fullFromZero: {
            finishReason: parseFinish,
            textChars: parseChars,
            error: parseError
          },
          midReattach: {
            fromEvent: midEvent,
            tailByteExact,
            reattachBytes: midBytes.length,
            expectedBytes: expectedTail.length,
            parse: {
              finishReason: midParseFinish,
              textChars: midParseChars,
              error: midParseError
            }
          }
        });
      }

      case "/run": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);
        // Optional opt-in header experiment: ?h=Header-Name:value,Other:value
        const hParam = url.searchParams.get("h");
        const extraHeaders: Record<string, string> | undefined = hParam
          ? Object.fromEntries(
              hParam.split(",").map((pair) => {
                const idx = pair.indexOf(":");
                return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
              })
            )
          : undefined;
        try {
          const full = await startRun(
            env,
            model,
            gateway,
            prompt,
            extraHeaders
          );
          return Response.json({
            model,
            runId: full.runId,
            status: full.status,
            contentType: full.contentType,
            headers: full.interestingHeaders,
            totalBytes: full.bytes.length,
            eventCount: full.eventOffsets.length,
            preview: preview(full.bytes, 1000)
          });
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : String(e), 502);
        }
      }

      case "/resume": {
        const runId = url.searchParams.get("runId");
        const from = url.searchParams.get("from") ?? "0";
        if (!runId) return jsonError("Missing ?runId=", 400);
        const res = await resume(env, gateway, runId, from);
        // SSE is UTF-8 text; decode for a type-safe, inspection-friendly body.
        return new Response(td.decode(res.bytes), {
          status: res.status,
          headers: { "Content-Type": "text/event-stream" }
        });
      }

      // Risk #4 — resume EXPIRY / not-found contract. JSON, so the status code,
      // gateway headers, and body shape are inspectable. Resume an arbitrary
      // runId (real-but-aged, or fabricated) to learn what the buffer returns
      // once it's gone — the signal the tiered recovery in RFC §7 keys off.
      case "/resume-info": {
        const runId = url.searchParams.get("runId");
        const from = url.searchParams.get("from") ?? "0";
        if (!runId) return jsonError("Missing ?runId=", 400);
        const res = await resume(env, gateway, runId, from);
        return Response.json({
          runId,
          from,
          status: res.status,
          headers: res.headers,
          bytes: res.bytes.length,
          preview: preview(res.bytes, 400)
        });
      }

      // Risk #6 — server-side fallback (gateway path). Pass ordered models;
      // a bad first entry forces a fallback step. Reports cf-aig-step.
      //   /fallback?models=openai/nope-xyz,openai/gpt-5.4
      case "/fallback": {
        const models = url.searchParams
          .get("models")
          ?.split(",")
          .map((m) => m.trim());
        if (!models || models.length === 0)
          return jsonError("Missing ?models=a,b", 400);
        try {
          const res = await runGatewayArray(env, models, gateway, prompt);
          return Response.json({
            experiment: "server-side-fallback",
            models,
            ...res
          });
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : String(e), 502);
        }
      }

      // Risk #6 — caching (gateway path). Two identical NON-streaming requests;
      // expect cf-aig-cache-status MISS then HIT (if caching is enabled on the
      // gateway and the response is cacheable).
      //   /cache?model=openai/gpt-5.4&ttl=3600
      case "/cache": {
        const model = url.searchParams.get("model");
        if (!model) return jsonError("Missing ?model=", 400);
        const ttl = url.searchParams.get("ttl") ?? "3600";
        const headers = { "cf-aig-cache-ttl": ttl };
        try {
          // Non-streaming for cacheability: strip stream from the entry.
          const entry = gatewayEntry(model, prompt, headers);
          (entry.query as Record<string, unknown>).stream = false;
          const aiWithGateway = env.AI as unknown as {
            gateway(id: string): {
              run(
                body: unknown,
                o?: Record<string, unknown>
              ): Promise<Response>;
            };
          };
          const gw = aiWithGateway.gateway(gateway);
          const first = await gw.run([entry]);
          const firstHeaders = collectHeaders(first.headers);
          await first.text();
          const second = await gw.run([entry]);
          const secondHeaders = collectHeaders(second.headers);
          await second.text();
          return Response.json({
            experiment: "caching",
            model,
            ttl,
            first: { status: first.status, headers: firstHeaders },
            second: { status: second.status, headers: secondHeaders }
          });
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : String(e), 502);
        }
      }

      default:
        return jsonError("Not found", 404);
    }
  }
} satisfies ExportedHandler<Env>;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
