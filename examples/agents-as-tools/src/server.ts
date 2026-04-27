/**
 * Agents-as-tools example.
 *
 * Demonstrates the pattern where, during a single chat turn, the
 * assistant dispatches a **helper sub-agent** to do multi-step work,
 * and that helper's lifecycle events stream live into the chat UI as
 * the turn unfolds.
 *
 *     Assistant (top-level Think DO, "demo")
 *       │  during a turn the model calls the `research` tool, which:
 *       │    1. spawns a Researcher facet
 *       │    2. opens an RPC ReadableStream from researcher.startAndStream(...)
 *       │    3. forwards each event onto the chat WebSocket via this.broadcast(...)
 *       │    4. captures the final summary and returns it as the tool output
 *       │    5. deletes the Researcher facet (per-turn lifetime)
 *       ▼
 *     Researcher (per-helper-run facet)
 *       - has its own (single-channel) ResumableStream — events are
 *         durable on the helper's own SQLite
 *       - exposes startAndStream(query, helperId): ReadableStream<Uint8Array>
 *         over DO RPC; each line is an NDJSON `{ sequence, body }` frame
 *       - exposes getActiveStreamId / getStoredEvents for reconnect-replay
 *
 * Per-turn lifetime: the Researcher facet is created at the start of
 * each tool call and deleted in `finally`. Persistent helpers (Ring 5
 * in the design notes) are a future extension.
 *
 * This is the v0.1 prototype matching the 2026-04-27 design pivot in
 * `wip/inline-sub-agent-events.md`:
 *
 *   - **Helpers are real sub-agents** with their own DO and SQLite.
 *     Each has its own `ResumableStream` (single channel) configured
 *     with `messageType: "helper-event"` so its replay frames don't
 *     collide with the chat protocol.
 *
 *   - **The parent forwards** events from the helper's stream onto
 *     its own WebSocket via `this.broadcast`. Browser keeps one WS to
 *     the parent. No second connection needed.
 *
 *   - **Reconnect replay**: the parent maintains a tiny
 *     `active_helpers` table; on `onConnect` it fetches each in-flight
 *     helper's stored events and forwards them to the new client.
 *
 *   - **Helper-as-tool**, hand-rolled. The `research` tool's
 *     `execute` is the proto-shape of what the eventual
 *     `helperTool(Cls)` framework helper would generate
 *     automatically (Stage 4 in the design notes).
 *
 *   - **Helper protocol, deliberately small.** Six event kinds:
 *     started / step / tool-call / tool-result / finished / error.
 *     Validation against more helper classes will tell us whether
 *     this is the right vocabulary or whether we need AI SDK
 *     `UIMessagePart` reuse (Ring 2 open question).
 *
 * Limitations of v0.1, all explicit and called out in README:
 *
 *   - **Parallel helper fan-out is untested.** The protocol should
 *     support it (`parentToolCallId` + `sequence` demux each helper
 *     run), but v0.2 should stress it before we claim it as a feature.
 *   - **Per-turn only.** Helpers are deleted at the end of each tool
 *     execute. Persistent / resumable helpers come later.
 *   - **Cancellation half-wired.** Aborting the parent turn aborts
 *     the in-flight tool execute; mid-helper LLM calls don't yet
 *     receive that signal.
 *   - **No "live tail" subscription.** If the parent crashes
 *     mid-helper, the run is lost; the helper's stored events still
 *     replay on parent reconnect, but there's no reconstitution of
 *     the live broadcast loop. Acceptable for per-turn helpers.
 *   - **Built on Think.** AIChatAgent port deferred; the Researcher
 *     class extends `Agent` directly and the helper-event protocol
 *     doesn't reference Think types, so the port should be cheap.
 */

import {
  Agent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext
} from "agents";
import { ResumableStream } from "agents/chat";
import { Think } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { generateText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { nanoid } from "nanoid";
import { z } from "zod";

import type { HelperEvent, HelperEventMessage } from "./protocol";

/** Wire frame `type` tag the helper's `ResumableStream` stamps on replay frames. */
const HELPER_EVENT_TYPE = "helper-event";

// ── Researcher (helper sub-agent, per-turn lifetime) ───────────────

/**
 * A helper sub-agent that simulates a multi-step research workflow.
 *
 * **State containment.** The helper owns its own `ResumableStream`
 * (`messageType: "helper-event"`), so its events are durably stored
 * on its own SQLite. The parent doesn't store helper events — it
 * forwards them via DO-RPC reads + WebSocket broadcasts. On parent
 * reconnect, the parent re-fetches stored events from the helper to
 * replay to the connecting client.
 *
 * **Drill-in is free.** Because the helper is a real sub-agent, a
 * curious developer can open a second `useAgent({ sub: [...] })`
 * connection directly to it for a detail view — the routing
 * primitive Just Works. v0.1 doesn't wire this up in the example UI,
 * but the capability is inherent.
 *
 * **What it actually does (v0.1):**
 *
 *   1. Picks a small set of "aspects" deterministically from the
 *      query (no LLM call here — keeps the demo fast and offline-
 *      friendly).
 *   2. Emits one `step` event per aspect with a 600–1200ms delay so
 *      the live progress is visible.
 *   3. Emits `tool-call` / `tool-result` pairs for each aspect,
 *      simulating fan-out to a search tool.
 *   4. Calls Workers AI to synthesize a final summary. This is the
 *      one real LLM call inside the helper; everything else is the
 *      protocol scaffolding.
 *   5. Emits `finished` with the synthesized summary, which becomes
 *      the tool's output to the parent's LLM.
 *
 * Extends `Agent`, not `Think` — a helper doesn't need a chat
 * lifecycle of its own. Per-turn helpers live for one tool execution
 * and get wiped via `deleteSubAgent` in the parent's `finally`.
 */
export class Researcher extends Agent<Env> {
  /**
   * Lazy — created on first access so that `restore()` runs after
   * the agent's storage is fully initialized.
   */
  private _stream?: ResumableStream;

  private get stream(): ResumableStream {
    if (!this._stream) {
      this._stream = new ResumableStream(this.sql.bind(this), {
        messageType: HELPER_EVENT_TYPE
      });
    }
    return this._stream;
  }

  /**
   * Start a research run and return a byte-encoded `ReadableStream`
   * of NDJSON helper-event frames. The parent reads bytes, decodes,
   * and forwards each frame onto its own WS.
   *
   * Events are also written to the helper's own `ResumableStream` as
   * they're emitted, so they survive parent reconnects: if the browser
   * refreshes mid-run, the parent re-fetches stored events via
   * {@link getStoredEvents} and replays them to the new client.
   *
   * Each NDJSON line carries `{ sequence, body }` where `sequence`
   * is the helper-local index (matches `chunk_index` in this helper's
   * `ResumableStream`) and `body` is the stringified `HelperEvent`.
   *
   * **Why bytes (Uint8Array) and not object chunks:** workerd's DO
   * RPC layer streams `ReadableStream<Uint8Array>` over the bridge.
   * Object chunks are not transferred — the consumer's `reader.read()`
   * fires "Network connection lost" before any data flows. This
   * matches the canonical Cloudflare DO ReadableStream example, which
   * uses `TextEncoder.encode(...)` exclusively. See:
   * https://developers.cloudflare.com/durable-objects/examples/readable-stream
   *
   * **Why all the work happens inside `start(controller)`:** workerd
   * treats the ReadableStream's `start()` (or `pull()`) callback as
   * live I/O for as long as it's executing. Driving emits from
   * `controller.enqueue` keeps the helper facet alive across the
   * `await sleep(...)` and LLM-call pauses between events.
   */
  startAndStream(query: string, helperId: string): ReadableStream<Uint8Array> {
    const stream = this.stream;
    const env = this.env;
    const helperType = this.constructor.name;
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const streamId = stream.start(helperId);
        let sequence = 0;

        const emit = (event: HelperEvent) => {
          const body = JSON.stringify(event);
          // Durably store first, then flush, so a reader that
          // subscribes after the event happened (e.g. parent's
          // onConnect replay) sees it via getStoredEvents. Helper
          // events are low-volume; the batched-write optimization in
          // ResumableStream isn't needed and would expand the dedup
          // window for refresh-mid-helper.
          stream.storeChunk(streamId, body);
          stream.flushBuffer();
          const seq = sequence++;

          // NDJSON line: one frame per line, JSON.stringify never
          // emits literal newlines so splitting on \n is safe.
          const line = `${JSON.stringify({ sequence: seq, body })}\n`;
          try {
            controller.enqueue(encoder.encode(line));
          } catch {
            // Controller closed (consumer cancelled). Storage
            // already happened; reconnect-replay still works.
          }
        };

        try {
          emit({ kind: "started", helperId, helperType, query });
          await sleep(400);

          // Step 1: plan. Deterministic aspect generation for v0 —
          // keeps the demo runnable without an extra LLM round-trip.
          emit({
            kind: "step",
            helperId,
            step: 1,
            description: "Planning research aspects…"
          });
          await sleep(400);

          const aspects = planAspects(query);

          // Steps 2..N: "search" each aspect with a simulated latency
          // and an interleaved tool-call/tool-result pair.
          for (let i = 0; i < aspects.length; i++) {
            const aspect = aspects[i];
            const stepNum = i + 2;
            emit({
              kind: "step",
              helperId,
              step: stepNum,
              description: `Searching: ${aspect}`
            });

            const searchToolCallId = nanoid(8);
            emit({
              kind: "tool-call",
              helperId,
              toolCallId: searchToolCallId,
              toolName: "web_search",
              input: { query: aspect }
            });

            await sleep(600 + Math.random() * 600);

            emit({
              kind: "tool-result",
              helperId,
              toolCallId: searchToolCallId,
              output: {
                aspect,
                sources: [
                  `https://example.com/search?q=${encodeURIComponent(aspect)}`,
                  "https://example.com/another-relevant-result"
                ],
                findings: `Simulated findings for "${aspect}". A v1 helper would call a real search API here.`
              }
            });
          }

          // Final step: synthesize. The one real LLM call.
          const synthesisStep = aspects.length + 2;
          emit({
            kind: "step",
            helperId,
            step: synthesisStep,
            description: "Synthesizing findings…"
          });

          const summary = await synthesize(env.AI, query, aspects);

          emit({ kind: "finished", helperId, summary });
          stream.complete(streamId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            emit({ kind: "error", helperId, error: message });
          } catch {
            // Best-effort.
          }
          stream.markError(streamId);
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
      cancel() {
        // Consumer (parent) cancelled — typically because the tool
        // execute was interrupted. The active stream metadata stays
        // in 'streaming' state; onStart's sweep on parent wake will
        // clean up if needed.
      }
    });
  }

  /**
   * Returns the active stream id if this helper has an in-flight
   * run, or null otherwise. Used by the parent on reconnect to
   * decide whether to replay events for this helper.
   */
  async getActiveStreamId(): Promise<string | null> {
    return this.stream.activeStreamId;
  }

  /**
   * Returns the stored events for a given stream id, ordered by
   * chunk index. Used by the parent on reconnect to replay events
   * to the newly-connected client.
   */
  async getStoredEvents(
    streamId: string
  ): Promise<Array<{ chunkIndex: number; body: string }>> {
    return this.stream
      .getStreamChunks(streamId)
      .map((c) => ({ chunkIndex: c.chunk_index, body: c.body }));
  }
}

// ── Assistant (top-level Think parent) ─────────────────────────────

/**
 * The chat agent the browser connects to. Built on Think to inherit
 * the agentic loop, message persistence, stream resumption, and
 * client-tool support.
 *
 * Demo-specific pieces:
 *
 *   - `getTools()` returns one tool, `research`, that wraps the
 *     `Researcher` helper sub-agent. Each tool call spawns a fresh
 *     `Researcher` facet, opens an RPC `ReadableStream` from its
 *     `startAndStream`, broadcasts each event onto the chat WS, and
 *     deletes the helper after the run.
 *
 *   - `active_helpers` is a tiny join table that lets `onConnect`
 *     replay in-flight helpers' events to a newly-reconnecting
 *     client. Rows are inserted at the start of a tool execute and
 *     deleted in the same `finally` that wipes the helper.
 *
 *   - `onConnect` runs after Think's chat-protocol setup (chat
 *     replay or full-history broadcast). It then walks
 *     `active_helpers`, fetches each helper's stored events, and
 *     forwards them as `helper-event` frames so the new client sees
 *     the full timeline of any helper currently running.
 */
export class Assistant extends Think<Env> {
  override onStart() {
    // Track in-flight helpers so onConnect can replay their events
    // to a newly-connecting client. Rows are short-lived: inserted
    // at tool-execute start, deleted in tool-execute finally.
    this.sql`create table if not exists active_helpers (
      helper_id text primary key,
      parent_tool_call_id text not null,
      started_at integer not null
    )`;

    // Sweep stale rows from a previous parent crash. `onStart` only
    // runs on parent wake — if the parent is alive, no `finally`
    // ever skipped, so any row here must be a leftover from a tool
    // execute that was interrupted by the crash. The forwarding loop
    // is gone; the helper's facet is leaked. Wipe both.
    //
    // Without this sweep, `onConnect` would still find the row, see
    // the helper's stream as `streaming` (restore() picks it up from
    // SQLite), and replay events to clients with no live continuation
    // — leaving the UI with a "Running" panel that never resolves.
    const stale = this.sql<{ helper_id: string }>`
      select helper_id from active_helpers
    `;
    for (const { helper_id } of stale) {
      try {
        this.deleteSubAgent(Researcher, helper_id);
      } catch {
        // Best-effort. The helper might already be gone, or there
        // might be a transient framework issue. Either way the row
        // gets cleared next.
      }
    }
    this.sql`delete from active_helpers`;
  }

  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.5", {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return [
      "You are a friendly, concise assistant.",
      "When the user asks for research or background on a topic,",
      "use the `research` tool — it dispatches a helper agent that",
      "investigates the topic in steps and returns a synthesized",
      "summary. After the tool returns, give the user a brief,",
      "well-structured reply that builds on the helper's findings.",
      "If the user is just chatting, answer directly without the",
      "tool."
    ].join(" ");
  }

  override getTools(): ToolSet {
    return {
      research: tool({
        description:
          "Dispatch a Researcher helper to investigate a topic in depth. " +
          "The helper does multi-step search and synthesis; you summarize " +
          "the result for the user. Returns the helper's synthesized summary.",
        inputSchema: z.object({
          query: z
            .string()
            .min(3)
            .describe(
              "The research topic. Be specific — e.g. 'How does HTTP/3 differ from HTTP/2?' rather than 'HTTP'."
            )
        }),
        execute: async ({ query }, { toolCallId }) => {
          return await this.runResearchHelper(query, toolCallId);
        }
      })
    };
  }

  /**
   * Spawns a Researcher facet, reads its event stream over DO RPC,
   * forwards each event to all connected clients via `this.broadcast`,
   * and returns the helper's final summary as the tool's output.
   *
   * This is the proto-shape of the eventual `helperTool(Researcher)`
   * framework helper — kept inline so the wiring is visible. When
   * Stage 4 lands, this collapses to:
   *
   *   research: helperTool(Researcher, { description, inputSchema })
   *
   * and the spawn / stream / broadcast / cleanup loop moves into the
   * framework.
   */
  private async runResearchHelper(
    query: string,
    parentToolCallId: string
  ): Promise<{ summary: string }> {
    const helperId = nanoid(10);
    const helper = await this.subAgent(Researcher, helperId);

    // Track for reconnect-replay. A row here means: a tool execute
    // is currently reading from this helper's event stream and
    // forwarding to clients. On parent reconnect, onConnect replays
    // each row's stored events to the new client.
    this.sql`
      insert into active_helpers (helper_id, parent_tool_call_id, started_at)
      values (${helperId}, ${parentToolCallId}, ${Date.now()})
    `;

    let summary = "";
    let helperError: string | undefined;
    try {
      // RPC method returns a `ReadableStream` synchronously in the
      // implementation, but on the parent side it arrives wrapped
      // in a `Promise` via the JSRPC stub. The stream is bytes;
      // we decode and split on newlines to get NDJSON frames.
      const stream = await helper.startAndStream(query, helperId);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processFrame = (line: string): void => {
        let frame: { sequence: number; body: string };
        try {
          frame = JSON.parse(line) as { sequence: number; body: string };
        } catch {
          return;
        }
        const event = parseHelperEvent(frame.body);
        if (!event) return;
        const message: HelperEventMessage = {
          type: "helper-event",
          parentToolCallId,
          event,
          sequence: frame.sequence
        };
        this.broadcast(JSON.stringify(message));
        if (event.kind === "finished") summary = event.summary;
        if (event.kind === "error") helperError = event.error;
      };

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process any trailing partial frame (defensive — every
          // emit ends with \n so this should be empty in practice).
          if (buf.trim().length > 0) processFrame(buf);
          break;
        }

        buf += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 0) processFrame(line);
        }
      }

      if (helperError) {
        throw new Error(helperError);
      }
      if (!summary) {
        throw new Error("Researcher finished without returning a summary.");
      }
      return { summary };
    } finally {
      this.sql`delete from active_helpers where helper_id = ${helperId}`;
      // Per-turn lifetime: helper goes away after the run. The
      // routing primitive's `deleteSubAgent` aborts and wipes the
      // facet, including its `cf_ai_chat_stream_*` tables.
      this.deleteSubAgent(Researcher, helperId);
    }
  }

  /**
   * Replay events for any helpers that are still in-flight when a
   * client connects. Runs after Think's chat-protocol setup (which
   * has already sent `STREAM_RESUMING` or `MSG_CHAT_MESSAGES`).
   *
   * We re-fetch each active helper's stored events via DO RPC rather
   * than mirror them in our own storage. State containment: helper
   * events live on the helper.
   */
  override async onConnect(
    connection: Connection,
    _ctx: ConnectionContext
  ): Promise<void> {
    const active = this.sql<{
      helper_id: string;
      parent_tool_call_id: string;
    }>`select helper_id, parent_tool_call_id from active_helpers`;

    for (const { helper_id, parent_tool_call_id } of active) {
      try {
        const helper = await this.subAgent(Researcher, helper_id);
        const streamId = await helper.getActiveStreamId();
        if (!streamId) continue;

        const events = await helper.getStoredEvents(streamId);
        for (const { chunkIndex, body } of events) {
          const event = parseHelperEvent(body);
          if (!event) continue;
          // `chunkIndex` here is the same value the helper writes as
          // `sequence` for the live broadcast — using it directly
          // means a client can dedupe live-and-replay collisions by
          // (helperId, sequence) pair.
          const message: HelperEventMessage = {
            type: "helper-event",
            parentToolCallId: parent_tool_call_id,
            event,
            sequence: chunkIndex,
            replay: true
          };
          connection.send(JSON.stringify(message));
        }
      } catch (err) {
        // Best-effort — log and continue with the rest. A failure
        // here just means one helper's events don't replay; live
        // events from other helpers and from the chat itself are
        // unaffected.
        console.warn(
          `[Assistant] Failed to replay helper events for ${helper_id}:`,
          err
        );
      }
    }
  }
}

// ── Demo support ────────────────────────────────────────────────────

function planAspects(query: string): string[] {
  // Tiny deterministic decomposition. Real v1: a structured-output
  // LLM call with a zod schema. The point here is to show the
  // event-streaming protocol, not to demonstrate planning quality.
  const trimmed = query.trim();
  return [
    `Overview: ${trimmed}`,
    `Details and recent changes: ${trimmed}`,
    `Common concerns and trade-offs: ${trimmed}`
  ];
}

async function synthesize(
  ai: Ai,
  query: string,
  aspects: string[]
): Promise<string> {
  const workersai = createWorkersAI({ binding: ai });
  const result = await generateText({
    model: workersai("@cf/moonshotai/kimi-k2.5"),
    prompt: [
      `Synthesize a concise research summary for the following query.`,
      `Use 2–3 paragraphs. Be specific and avoid filler.`,
      ``,
      `Query: ${query}`,
      ``,
      `Aspects investigated:`,
      ...aspects.map((a, i) => `${i + 1}. ${a}`)
    ].join("\n")
  });
  return result.text.trim();
}

function parseHelperEvent(body: string): HelperEvent | null {
  try {
    return JSON.parse(body) as HelperEvent;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Worker entry ────────────────────────────────────────────────────
//
// `routeAgentRequest` already knows how to dispatch the nested
// `/agents/assistant/{name}/sub/researcher/...` shape — it walks the
// URL, wakes the Assistant parent, and forwards to the Researcher
// facet for any direct sub-agent connections (none in this demo, but
// the routing is free either way and it's how a future drill-in
// detail view would work).

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
