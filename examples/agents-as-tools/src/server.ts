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
 *       │    1. spawns a Researcher facet (its own Think instance)
 *       │    2. opens an RPC ReadableStream from researcher.runTurnAndStream(...)
 *       │    3. forwards each forwarded chat-stream chunk onto the chat WS
 *       │       inside a `helper-event` envelope via this.broadcast(...)
 *       │    4. captures the helper's final assistant message and returns it
 *       │       as the tool output to the parent's LLM
 *       │    5. retains the Researcher facet for replay until Clear / GC
 *       ▼
 *     Researcher (per-helper-run facet — itself a Think)
 *       - has its own `_resumableStream` (Think's own) — chunks are
 *         durable on the helper's own SQLite. No second `ResumableStream`
 *         on the helper to collide with.
 *       - exposes runTurnAndStream(query, helperId): ReadableStream<Uint8Array>
 *         over DO RPC. Each line is an NDJSON `{ sequence, body }` frame
 *         where `body` is a JSON-stringified `UIMessageChunk` from Think's
 *         `_streamResult` — same wire shape the helper's own WS clients see.
 *       - exposes getChatChunksForReplay() so the parent can replay a
 *         completed/in-progress helper after page refresh.
 *
 * Per-run lifetime: the Researcher facet is created at the start of
 * each tool call and retained after completion so its turn timeline
 * can replay after refresh. Clear/GC owns deletion.
 *
 * This is the v0.2 design ("Option B" in `wip/inline-sub-agent-events.md`),
 * which replaces v0.1's single-turn scripted helper with a real Think
 * helper that runs its own inference loop:
 *
 *   - **Helpers are themselves Think DOs.** They have their own model,
 *     system prompt, tools, session, fibers, and chat protocol. The
 *     helper's chat stream is the canonical durable event log — there
 *     is no second stream on the helper.
 *
 *   - **The wire vocabulary is the helper's chunk firehose.** Each
 *     forwarded `helper-event` of kind `chunk` carries an opaque
 *     `body` string that's a JSON-encoded `UIMessageChunk`. The
 *     client `applyChunkToParts` to rebuild the helper's
 *     `UIMessage.parts` (text, reasoning, tool calls, results) the
 *     same way `useAgentChat` does for the assistant's own messages.
 *     Lifecycle (`started`, `finished`, `error`) is synthesized by
 *     the parent so the panel can render even before any chunks
 *     arrive, and so the post-run replay path doesn't depend on the
 *     helper having stored a terminal chunk.
 *
 *   - **Drill-in is real chat.** Because the helper IS a Think, a
 *     curious developer can `useAgent({ sub: ["researcher", id] })`
 *     and `useAgentChat` against it directly to see the helper's full
 *     conversation in its own UI. v0.2 doesn't wire this up in the
 *     example UI, but the affordance is inherent.
 *
 *   - **Reconnect replay**: the parent maintains a tiny
 *     `cf_agent_helper_runs` registry. On `onConnect` it walks each
 *     row, synthesizes a `started` event from the row, fetches the
 *     helper's stored chat chunks, forwards them as `chunk` events,
 *     and appends a synthesized `finished`/`error` from the row.
 *
 *   - **Helper-as-tool**, hand-rolled. The `research` tool's
 *     `execute` is the proto-shape of what the eventual
 *     `helperTool(Cls)` framework helper would generate
 *     automatically (Stage 4 in the design notes).
 *
 * Limitations of v0.2, all explicit and called out in README:
 *
 *   - **Parallel helper fan-out is untested.** The protocol supports
 *     it (`parentToolCallId` + `sequence` demux each helper run); the
 *     example UI just doesn't drive it yet. Next task in the wip doc.
 *   - **No TTL/GC yet.** Helpers are kept after completion. Clear
 *     wipes them; time/count cleanup comes later.
 *   - **Cancellation half-wired.** Aborting the parent turn aborts
 *     the in-flight tool execute; mid-helper LLM calls don't yet
 *     receive that signal.
 *   - **No "live tail" subscription.** If the parent crashes
 *     mid-helper, the run is marked `interrupted`; the helper's
 *     stored chunks still replay on parent reconnect, but there's no
 *     reconstitution of the live broadcast loop.
 *   - **Built on Think.** AIChatAgent port deferred; the Researcher
 *     class extends `Think` and the helper-event protocol doesn't
 *     reference Think types, so the AIChatAgent port is mechanical
 *     once we get to it.
 */

import { callable, routeAgentRequest, type Connection } from "agents";
import { Think } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { nanoid } from "nanoid";
import { z } from "zod";

import type { HelperEvent, HelperEventMessage } from "./protocol";

/** Wire frame `type` tag for helper-event envelopes broadcast on the chat WS. */
const HELPER_EVENT_TYPE = "helper-event";

/** Frame type Think uses for chat-response chunks broadcast over the WS. */
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

type HelperRunStatus = "running" | "completed" | "error" | "interrupted";

// ── Researcher (helper sub-agent — itself a Think) ────────────────

/**
 * A helper sub-agent that runs a focused multi-turn research loop and
 * returns a synthesized summary as the tool output.
 *
 * **Why it extends Think.** The helper IS a chat agent — it has its
 * own model, system prompt, tools, and inference loop. Reusing Think
 * gets us turn queueing, fiber recovery, durable chat-stream
 * resumption, and message persistence "for free." The parent doesn't
 * have to reinvent any of that.
 *
 * **State containment.** The helper's chat stream is durably stored
 * on its own SQLite via Think's own `_resumableStream`. There is no
 * second `ResumableStream` on the helper, so there's no two-stream
 * collision on the same DO (the original failure mode in #1377).
 *
 * **Drill-in is real chat.** Because the helper is a Think, a curious
 * developer can open a normal `useAgentChat` against it via
 * `useAgent({ sub: [...] })`. The example UI doesn't wire that up
 * yet, but the routing is free.
 *
 * **What it actually does (v0.2):** kicks off a Think turn against
 * its own model, with one tool (`web_search`) returning simulated
 * results, and runs the loop until the model produces a final
 * assistant message. The parent reads each chat-stream chunk as it
 * lands and forwards it inside a `helper-event` envelope.
 */
export class Researcher extends Think<Env> {
  /**
   * Disable Think's chat-recovery fiber. Helpers are per-turn workers
   * driven over RPC by the parent; recovering an in-flight turn after
   * the helper hibernates would re-run the inference loop into a
   * parent that is no longer listening (the parent has already
   * marked the run `interrupted`). Default-on `chatRecovery` would
   * silently burn another LLM call into nothing on every wake.
   */
  override chatRecovery = false;

  /**
   * Forwarder set for the duration of a single `runTurnAndStream`.
   * The overridden {@link broadcast} tees `MSG_CHAT_RESPONSE` chunks
   * into this callback, which writes them onto the RPC `ReadableStream`
   * the parent is reading.
   */
  private _activeForwarder?: (chunkBody: string) => void;

  /**
   * Sync claim flag set at the entry of `runTurnAndStream` and
   * cleared in its `finally` / `cancel`. Prevents concurrent calls
   * on the same helper instance from corrupting each other's
   * forwarder/requestId state. Single-slot is correct here — the
   * parent always spawns a fresh helper per tool call.
   *
   * The flag has to be sync at entry (rather than waiting until
   * `start(controller)` fires) because `start` is invoked lazily
   * when the consumer reads, so two concurrent calls could both
   * pass an `_activeForwarder !== undefined` check.
   */
  private _runInProgress = false;

  /**
   * The most recent error broadcast by Think's `_streamResult` mid-stream
   * (i.e. `error: true` chat-response frames). Stashed here so the parent's
   * outer catch can surface the *actual* error message instead of a generic
   * "no summary returned" fallback. Cleared at the start of each turn.
   */
  private _lastStreamError?: string;

  /**
   * The set of assistant-message ids present BEFORE the current turn
   * started. Used by {@link getFinalTurnText} to identify the message
   * persisted by THIS turn rather than walking backwards (which would
   * pick up a drill-in user's later message and feed it back to the
   * orchestrating LLM as the helper's "summary").
   */
  private _preTurnAssistantIds?: Set<string>;

  /**
   * The `requestId` of the in-flight turn driven by `runTurnAndStream`.
   * Captured before `saveMessages` resolves so that the parent's
   * `cancel` callback can call {@link abortCurrentTurn} and have it
   * cancel the right registry entry.
   */
  private _activeRequestId?: string;

  /**
   * Tee chat-response chunks to the active RPC stream while a
   * `runTurnAndStream` is in flight. Other broadcasts (state,
   * identity, MSG_CHAT_MESSAGES, helper-event from any future
   * downstream) pass through untouched.
   */
  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (this._activeForwarder && typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as {
          type?: unknown;
          body?: unknown;
          error?: unknown;
        };
        if (parsed && parsed.type === MSG_CHAT_RESPONSE) {
          if (parsed.error === true) {
            // Think's `_streamResult` broadcasts the error message as
            // the `body` of an `error: true` frame; this is NOT a
            // `UIMessageChunk` shape, so forwarding it through the
            // chunk pipeline would silently fail at `applyChunkToParts`
            // on the client. Stash it so the parent's outer catch can
            // surface the real cause instead of a generic
            // "no summary" fallback.
            if (typeof parsed.body === "string") {
              this._lastStreamError = parsed.body;
            }
          } else if (
            typeof parsed.body === "string" &&
            parsed.body.length > 0
          ) {
            // `body` is the JSON-stringified `UIMessageChunk` from
            // Think's `_streamResult`. Forward verbatim — the client's
            // `applyChunkToParts` expects exactly this shape.
            this._activeForwarder(parsed.body);
          }
        }
      } catch {
        // Not JSON / not a chat frame — pass through without teeing.
      }
    }
    super.broadcast(msg, without);
  }

  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.5", {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return [
      "You are a focused research helper agent.",
      "Your job is to investigate a topic in depth and produce a",
      "concise, well-structured summary that the parent assistant can",
      "build on. Use the `web_search` tool to gather information,",
      "then synthesize 2-3 paragraphs of substantive analysis.",
      "Cite specifics from your tool results. When you have enough",
      "information, end with the summary as your final assistant",
      "message — do not call further tools after writing the summary."
    ].join(" ");
  }

  override getTools(): ToolSet {
    return {
      web_search: tool({
        description:
          "Search the web for information on a topic. Returns a small set of simulated results.",
        inputSchema: z.object({
          query: z
            .string()
            .min(2)
            .describe(
              "The search query — narrow and specific (e.g. 'HTTP/3 vs HTTP/2 head-of-line blocking') rather than broad."
            )
        }),
        execute: async ({ query }) => {
          // Simulated results so the helper exercises the multi-turn
          // inference loop without needing a real search backend.
          // Production would call Brave / Bing / Tavily / etc. here.
          return {
            query,
            results: [
              {
                title: `Background on "${query}"`,
                snippet:
                  `Comprehensive overview of ${query}. Recent industry analysis surfaces several ` +
                  `architectural shifts in the past two years; practitioners report mixed results ` +
                  `depending on workload characteristics.`,
                url: `https://example.com/search?q=${encodeURIComponent(query)}`
              },
              {
                title: `Recent changes related to "${query}"`,
                snippet:
                  `Latest updates and trade-offs around ${query}. Notable contributors include ` +
                  `several major open-source projects whose recent releases changed default ` +
                  `behavior in production deployments.`,
                url: `https://example.com/research?topic=${encodeURIComponent(query)}`
              }
            ]
          };
        }
      })
    };
  }

  /**
   * Drive a single research turn for `query` and stream the resulting
   * chat-stream chunks back to the parent as NDJSON `{ sequence, body }`
   * frames. Returns when the turn fully completes (success or error).
   *
   * The body of each NDJSON frame is a JSON-encoded `UIMessageChunk`
   * — the same wire shape the helper's own WS clients receive. The
   * parent doesn't try to interpret the chunks; it forwards them
   * inside a `helper-event` envelope so the client can apply them
   * via `applyChunkToParts` and render the helper's growing
   * `UIMessage` exactly the way `useAgentChat` would.
   *
   * **Why bytes (Uint8Array) and not object chunks:** workerd's DO
   * RPC layer streams `ReadableStream<Uint8Array>` over the bridge.
   * Object chunks are not transferred — the consumer's `reader.read()`
   * fires "Network connection lost" before any data flows. See
   * https://github.com/cloudflare/workerd/issues/6675.
   *
   * **Why all the work happens inside `start(controller)`:** workerd
   * treats the ReadableStream's `start()` callback as live I/O for as
   * long as it's executing. Driving `saveMessages` from inside
   * `start` keeps the helper facet alive across the inference loop
   * pauses. We also wrap the body in `keepAliveWhile` to make the
   * intent explicit at the Agents layer.
   */
  async runTurnAndStream(
    query: string,
    _helperId: string
  ): Promise<ReadableStream<Uint8Array>> {
    const self = this;

    // Concurrent-call guard. Sync at entry — see `_runInProgress`
    // doc for why a forwarder-based check would race.
    //
    // Note: throwing here surfaces both as an awaited rejection on
    // the parent (which is what the parent's tool execute catches)
    // and, in some workerd versions, as an unhandled-rejection trail
    // emitted by the JSRPC bridge. The trail is benign — the parent
    // already handles the error correctly — but it can light up
    // vitest's unhandled-error detector. Returning a stream that
    // errors-on-read instead loses the concrete error message via
    // workerd's "Network connection lost" wrapper (cloudflare/workerd
    // issue #6675), so the sync throw stays as the cleanest UX.
    if (self._runInProgress) {
      throw new Error(
        "Researcher.runTurnAndStream is already running on this instance — concurrent calls are not supported."
      );
    }
    self._runInProgress = true;

    const releaseClaim = () => {
      self._runInProgress = false;
      self._activeForwarder = undefined;
      self._activeRequestId = undefined;
    };

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let sequence = 0;

        // Reset per-turn state.
        self._lastStreamError = undefined;
        self._activeRequestId = undefined;
        // Snapshot assistant ids BEFORE the turn so the parent can
        // identify the assistant message THIS turn produced, even if
        // a drill-in client appended turns after ours.
        self._preTurnAssistantIds = new Set(
          self.messages.filter((m) => m.role === "assistant").map((m) => m.id)
        );

        // Wire the broadcast tee. Set BEFORE saveMessages so the
        // first chat-response chunk that lands is captured.
        self._activeForwarder = (chunkBody) => {
          try {
            const line = `${JSON.stringify({ sequence, body: chunkBody })}\n`;
            sequence += 1;
            controller.enqueue(encoder.encode(line));
          } catch {
            // Controller closed (consumer cancelled). Storage already
            // happened via Think's `_resumableStream.storeChunk`;
            // reconnect-replay still works.
          }
        };

        try {
          // `saveMessages` already wraps its body in `keepAliveWhile`
          // (see Think); a second outer wrap is redundant. The result
          // carries the requestId so the cancel path can target the
          // right registry entry via `abortCurrentTurn`.
          const result = await self.saveMessages([
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: query }]
            }
          ]);
          self._activeRequestId = result.requestId;
        } catch (err) {
          releaseClaim();
          try {
            controller.error(
              err instanceof Error ? err : new Error(String(err))
            );
          } catch {
            // Already errored / closed.
          }
          return;
        }

        releaseClaim();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      },
      cancel() {
        // Consumer (parent) cancelled — typically because the parent's
        // tool execute was aborted, the parent crashed, or a sibling
        // tab issued `clearHelperRuns`. Abort the in-flight Think turn
        // so we don't keep paying Workers AI for output the parent
        // will never read. Already-stored chunks stay durable for
        // reconnect-replay.
        if (self._activeRequestId !== undefined) {
          void self.abortCurrentTurn();
        }
        releaseClaim();
      }
    });
  }

  /**
   * Cancel whatever turn `runTurnAndStream` is currently driving.
   * Wired to {@link AbortRegistry.cancel} via the captured request id.
   *
   * Think's `_aborts` is `private`, so we reach into it via bracket
   * access — there's no public Think API for "abort this specific
   * request" (the framework's only abort surfaces are `MSG_CHAT_CANCEL`
   * over WebSocket and `destroyAll()` on agent shutdown). Promoting
   * this to a Think public method is the right long-term fix.
   */
  async abortCurrentTurn(): Promise<void> {
    const requestId = this._activeRequestId;
    if (!requestId) return;
    const aborts = (
      this as unknown as { _aborts: { cancel(id: string): void } }
    )._aborts;
    aborts.cancel(requestId);
  }

  /**
   * Returns the helper's stored chat-stream chunks for replay.
   * Reads from Think's own `_resumableStream` — its `getStreamChunks`
   * is `@internal` but `public` so cross-DO RPC can call it. Picks
   * the most recently created stream (a helper has at most one turn
   * per its lifetime in this example).
   *
   * Used by the parent's `onConnect` to fetch chunks for a helper
   * run that's in progress, completed, or interrupted.
   */
  async getChatChunksForReplay(): Promise<
    Array<{ chunkIndex: number; body: string }>
  > {
    this._resumableStream.flushBuffer();
    const allMeta = this._resumableStream.getAllStreamMetadata();
    if (allMeta.length === 0) return [];
    const latest = [...allMeta].sort((a, b) => b.created_at - a.created_at)[0];

    // Orphan detection: if the latest stream's metadata is still
    // `streaming` but the live LLM reader is gone (the helper was
    // hibernated mid-turn and reconstructed without `replayChunks`
    // ever firing), finalize the metadata so it doesn't sit in flight
    // forever. The chunks remain readable; only the metadata moves
    // to `completed`. Reconnect-replay correctness is unchanged.
    if (
      latest.status === "streaming" &&
      this._resumableStream.activeStreamId === latest.id &&
      !this._resumableStream.isLive
    ) {
      this._resumableStream.complete(latest.id);
    }

    return this._resumableStream
      .getStreamChunks(latest.id)
      .map((c) => ({ chunkIndex: c.chunk_index, body: c.body }));
  }

  /**
   * Returns the text of the assistant message produced by the most
   * recent {@link runTurnAndStream}, or `null` if none has been
   * persisted yet (or no turn has run on this helper).
   *
   * Identifies "the assistant message from THIS turn" by diffing the
   * current message ids against the snapshot taken at the start of
   * the turn — robust against drill-in clients having appended their
   * own turns before the parent reads the summary. Falling back to
   * "the most recent assistant text" would feed a drill-in user's
   * message back to the orchestrator as the helper's research summary.
   */
  async getFinalTurnText(): Promise<string | null> {
    const messages = this.messages;
    const before = this._preTurnAssistantIds;
    if (before === undefined) {
      // No turn has run on this helper. Caller asked for a summary
      // that never existed.
      return null;
    }
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      if (before.has(msg.id)) continue;
      const text = msg.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter((t) => t.length > 0)
        .join("\n");
      if (text.length > 0) return text;
    }
    return null;
  }

  /**
   * Returns the most recent stream-error body broadcast by Think's
   * `_streamResult`, or `null` if the last turn completed cleanly.
   * Used by the parent to surface the actual cause of a no-summary
   * failure instead of a generic fallback message.
   */
  async getLastStreamError(): Promise<string | null> {
    return this._lastStreamError ?? null;
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
 *     `runTurnAndStream`, and broadcasts each chat chunk onto the
 *     chat WS inside a `helper-event` envelope.
 *
 *   - `cf_agent_helper_runs` is a small registry that lets `onConnect`
 *     replay helper timelines to a newly-reconnecting client, even
 *     after the helper has completed. Rows track lifecycle metadata
 *     (helperType, query, summary, errorMessage) so the parent can
 *     synthesize `started`/`finished`/`error` events on replay
 *     without re-reading the helper's full message history.
 *
 *   - `onConnect` runs after Think's chat-protocol setup (chat replay
 *     or full-history broadcast). It then walks `cf_agent_helper_runs`,
 *     synthesizes a `started` event from row data, fetches the
 *     helper's stored chat chunks, forwards them as `chunk` events,
 *     and appends a synthesized `finished`/`error` lifecycle event.
 */
export class Assistant extends Think<Env> {
  override onStart() {
    // Track helper runs so onConnect can replay their timelines to
    // newly-connecting clients. Completed/error helper DOs are kept
    // around until clear/GC so helper panels survive refresh after
    // the assistant turn finishes.
    //
    // Retention policy for this example: Clear deletes all rows and
    // helper facets. A production helper system would add age/count
    // based GC tied to message retention.
    this.sql`create table if not exists cf_agent_helper_runs (
      helper_id text primary key,
      parent_tool_call_id text not null,
      helper_type text not null,
      query text not null,
      status text not null,
      summary text,
      error_message text,
      started_at integer not null,
      completed_at integer
    )`;

    // Migration cleanup from earlier prototypes.
    this.sql`drop table if exists active_helpers`;

    // If the parent wakes up with a helper still marked running, the
    // forwarding loop that was reading from its RPC stream is gone.
    // Keep the helper DO and its stored chunks for replay, but mark
    // the run interrupted so the UI can show a terminal state instead
    // of a "Running" panel that never resolves.
    this.sql`
      update cf_agent_helper_runs
      set status = 'interrupted', completed_at = ${Date.now()}
      where status = 'running'
    `;
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
      "summary. When the user asks you to compare or contrast two",
      "topics, prefer the `compare` tool — it dispatches both",
      "helpers in parallel so the user sees both timelines unfolding",
      "side by side. After tools return, give the user a brief,",
      "well-structured reply that builds on the helpers' findings.",
      "If the user is just chatting, answer directly without tools."
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
      }),
      compare: tool({
        description:
          "Dispatch TWO Researcher helpers in parallel to investigate two " +
          "related topics simultaneously. Use for compare/contrast queries; " +
          "the user sees both helpers' timelines unfolding side-by-side " +
          "under the same tool call. Returns both summaries.",
        inputSchema: z.object({
          a: z.string().min(3).describe("First topic to investigate."),
          b: z
            .string()
            .min(3)
            .describe(
              "Second topic to investigate. Should be a sibling of `a` (e.g. comparing two protocols, libraries, approaches)."
            )
        }),
        execute: async ({ a, b }, { toolCallId }) => {
          // Both helpers share the parent's `toolCallId` so the client
          // renders them as siblings under the same chat tool part —
          // the visible "two helpers fanned out from one tool call"
          // pattern from cloudflare/agents#1377-comment-4328296343
          // (image 3). Per-helper demux on the client uses the
          // `helperId` carried inside each `helper-event`.
          const [aResult, bResult] = await Promise.all([
            this.runResearchHelper(a, toolCallId),
            this.runResearchHelper(b, toolCallId)
          ]);
          return {
            a: { query: a, summary: aResult.summary },
            b: { query: b, summary: bResult.summary }
          };
        }
      })
    };
  }

  /**
   * Spawns a Researcher facet, drives a Think turn on it, forwards
   * each chat-stream chunk to all connected clients via
   * `this.broadcast`, and returns the helper's final assistant text
   * as the tool's output.
   *
   * The proto-shape of the eventual `helperTool(Researcher)` framework
   * helper — kept inline so the wiring is visible. When Stage 4 lands
   * in the design notes, this collapses to:
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
    const helperType = Researcher.name;
    const startedAt = Date.now();
    const helper = await this.subAgent(Researcher, helperId);

    // Track for reconnect/history replay. `running` rows are updated
    // to `completed` / `error` when the helper finishes; rows remain
    // until clear/GC so the helper timeline survives page refresh
    // after the assistant turn has completed.
    this.sql`
      insert into cf_agent_helper_runs (
        helper_id,
        parent_tool_call_id,
        helper_type,
        query,
        status,
        started_at
      )
      values (
        ${helperId},
        ${parentToolCallId},
        ${helperType},
        ${query},
        'running',
        ${startedAt}
      )
    `;

    // Synthesize the `started` lifecycle event so the UI can render
    // a panel even before any chunks arrive.
    let sequence = 0;
    this._broadcastHelperEvent(parentToolCallId, sequence++, {
      kind: "started",
      helperId,
      helperType,
      query
    });

    let summary = "";
    try {
      const stream = await helper.runTurnAndStream(query, helperId);
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
        if (typeof frame.body !== "string" || frame.body.length === 0) return;
        // Re-stamp with the parent's per-run sequence (helper's
        // `frame.sequence` is independent; the parent's `sequence`
        // includes the synthesized `started`/`finished` lifecycle
        // events). Keeps client dedup/sort by parent sequence
        // monotonic across the full timeline.
        this._broadcastHelperEvent(parentToolCallId, sequence++, {
          kind: "chunk",
          helperId,
          body: frame.body
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
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

      // Read the synthesized summary from the helper's last assistant
      // message via DO RPC. `runTurnAndStream` only resolves once the
      // turn is fully persisted, so this is safe to call without
      // racing the inference loop. `getFinalTurnText` identifies the
      // message produced by THIS turn (not the latest assistant
      // message — drill-in clients can append more after).
      summary = (await helper.getFinalTurnText()) ?? "";

      if (!summary) {
        // Empty summary usually means Think's `_streamResult` caught
        // an inference error and broadcast it as an error frame
        // (which our broadcast tee captures into `_lastStreamError`)
        // rather than throwing through `saveMessages`. Prefer the
        // helper's actual error message over the generic fallback.
        const helperError = await helper.getLastStreamError();
        throw new Error(
          helperError ?? "Researcher finished without producing assistant text."
        );
      }

      this._broadcastHelperEvent(parentToolCallId, sequence++, {
        kind: "finished",
        helperId,
        summary
      });
      this._updateHelperRunCompleted(helperId, summary);
      return { summary };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this._broadcastHelperEvent(parentToolCallId, sequence++, {
        kind: "error",
        helperId,
        error: errorMessage
      });
      this._updateHelperRunErrored(helperId, errorMessage);
      throw err;
    }
    // No `finally { deleteSubAgent }` — the helper's Think DO owns
    // the durable chat-stream log, so retaining it is what lets
    // completed helper panels replay after refresh.
  }

  /**
   * Broadcast a single `helper-event` envelope to all connected
   * clients of the parent. Centralized so the wire format change is
   * one site, not three.
   */
  private _broadcastHelperEvent(
    parentToolCallId: string,
    sequence: number,
    event: HelperEvent
  ): void {
    const message: HelperEventMessage = {
      type: HELPER_EVENT_TYPE,
      parentToolCallId,
      event,
      sequence
    };
    this.broadcast(JSON.stringify(message));
  }

  private _updateHelperRunCompleted(helperId: string, summary: string): void {
    this.sql`
      update cf_agent_helper_runs
      set status = 'completed', completed_at = ${Date.now()}, summary = ${summary}
      where helper_id = ${helperId}
    `;
  }

  private _updateHelperRunErrored(
    helperId: string,
    errorMessage: string
  ): void {
    this.sql`
      update cf_agent_helper_runs
      set status = 'error', completed_at = ${Date.now()}, error_message = ${errorMessage}
      where helper_id = ${helperId}
    `;
  }

  /**
   * Replay events for any helper runs when a client connects. Runs
   * after Think's chat-protocol setup (which has already sent
   * `STREAM_RESUMING` or `MSG_CHAT_MESSAGES`).
   *
   * Each row contributes:
   *   - one synthesized `started` lifecycle event (sequence 0)
   *   - N forwarded `chunk` events (sequence 1..N) from the helper's
   *     own stored chat stream
   *   - one synthesized terminal `finished`/`error` lifecycle event
   *     (sequence N+1)
   *
   * Per-helper, sequence numbering matches what the live broadcast
   * path uses, so the client's `(parentToolCallId, sequence)` dedup
   * works seamlessly across a refresh during a helper turn.
   *
   * We re-fetch each helper's stored chunks via DO RPC rather than
   * mirror them on the parent. State containment: helper events live
   * on the helper.
   */
  override async onConnect(connection: Connection): Promise<void> {
    const helperRuns = this.sql<{
      helper_id: string;
      parent_tool_call_id: string;
      helper_type: string;
      query: string;
      status: HelperRunStatus;
      summary: string | null;
      error_message: string | null;
    }>`
      select helper_id, parent_tool_call_id, helper_type, query, status,
             summary, error_message
      from cf_agent_helper_runs
      order by started_at asc
    `;

    for (const row of helperRuns) {
      try {
        let sequence = 0;
        const sendReplay = (event: HelperEvent) => {
          const message: HelperEventMessage = {
            type: HELPER_EVENT_TYPE,
            parentToolCallId: row.parent_tool_call_id,
            event,
            sequence: sequence++,
            replay: true
          };
          connection.send(JSON.stringify(message));
        };

        sendReplay({
          kind: "started",
          helperId: row.helper_id,
          helperType: row.helper_type,
          query: row.query
        });

        const helper = await this.subAgent(Researcher, row.helper_id);
        const chunks = await helper.getChatChunksForReplay();
        for (const { body } of chunks) {
          sendReplay({ kind: "chunk", helperId: row.helper_id, body });
        }

        if (row.status === "completed") {
          sendReplay({
            kind: "finished",
            helperId: row.helper_id,
            summary: row.summary ?? ""
          });
        } else if (row.status === "error") {
          sendReplay({
            kind: "error",
            helperId: row.helper_id,
            error:
              row.error_message ??
              "Helper failed before reporting a terminal event."
          });
        } else if (row.status === "interrupted") {
          sendReplay({
            kind: "error",
            helperId: row.helper_id,
            error:
              "Helper was interrupted while the parent agent was restarting."
          });
        }
        // status === "running": no synthesized terminal — the live
        // broadcast loop in `runResearchHelper` will eventually emit
        // it on completion.
      } catch (err) {
        // Best-effort — log and continue with the rest. A failure
        // here just means one helper's events don't replay; live
        // events from other helpers and from the chat itself are
        // unaffected.
        console.warn(
          `[Assistant] Failed to replay helper events for ${row.helper_id}:`,
          err
        );
      }
    }
  }

  @callable()
  async clearHelperRuns(): Promise<void> {
    const runs = this.sql<{ helper_id: string }>`
      select helper_id from cf_agent_helper_runs
    `;
    for (const { helper_id } of runs) {
      try {
        this.deleteSubAgent(Researcher, helper_id);
      } catch {
        // Idempotent / best-effort cleanup. The helper may already be
        // gone (e.g. local dev state was wiped between runs).
      }
    }
    this.sql`delete from cf_agent_helper_runs`;
  }
}

// ── Worker entry ────────────────────────────────────────────────────
//
// `routeAgentRequest` already knows how to dispatch the nested
// `/agents/assistant/{name}/sub/researcher/...` shape — it walks the
// URL, wakes the Assistant parent, and forwards to the Researcher
// facet for any direct sub-agent connections. Since the helper is
// itself a Think, those direct connections produce a working
// `useAgentChat` against the helper for free (drill-in detail view).

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
