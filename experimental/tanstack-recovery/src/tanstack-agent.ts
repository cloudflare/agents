/**
 * `TanStackAgent` — the Phase-5 SECOND genericity harness.
 *
 * A Durable Object that drives a TanStack AI / AG-UI client over the SAME shared
 * `ChatRecoveryEngine` AND the SAME shared `ResumeHandshake` that `AIChatAgent`
 * and `Think` use. Where the [pi fixture](../../pi-recovery/src/pi-agent.ts)
 * proved the ENGINE is generic across a non-AI-SDK transcript, this proves the
 * other two seams the pi fixture left untouched:
 *
 *  1. **Resume handshake against a foreign client transport.** The client is a
 *     `@tanstack/ai` `SubscribeConnectionAdapter` (subscribe/send over a raw
 *     WebSocket), not the AI SDK's `useChat` reader. The shared `ResumeHandshake`
 *     still drives notify → REQUEST/ACK → replay → terminal (#1733/#1645)
 *     unchanged; a thin client `ws-bridge` translates the `cf_agent_*` frames
 *     into AG-UI `StreamChunk`s (Approach A — see the RFC). No engine change
 *     specific to this client.
 *  2. **Streaming codec against a foreign chunk vocabulary.** Buffered chunks are
 *     AG-UI `StreamChunk`s, reconstructed by {@link TanStackRecoveryCodec}, not
 *     pi events or AI SDK SSE. The engine still sees only `{ text, parts }`.
 *
 * Recovery model (mirrors pi's `stream_continuation`): a SIGKILL mid-stream
 * interrupts the fiber before the turn commits its assistant message. The
 * streamed `TEXT_MESSAGE_CONTENT` deltas were buffered durably (per-chunk) into
 * `ResumableStream`. On wake the engine reconstructs that partial through the
 * codec, preserves it, classifies a `continue`, and re-runs the turn priming the
 * faux model with only the REMAINING suffix — which merges onto the survived
 * prefix to land the same full reply. A deterministic faux model keeps the e2e's
 * continuation math exact.
 *
 * @internal Validation fixture, not a published package.
 */

import { Agent } from "agents";
import type {
  Connection,
  ConnectionContext,
  FiberContext,
  FiberRecoveryContext,
  WSMessage
} from "agents";
import { EventType } from "@tanstack/ai/client";
import type { ModelMessage } from "@tanstack/ai";
import {
  ChatRecoveryEngine,
  ContinuationState,
  ResumableStream,
  ResumeHandshake,
  buildChatRecoveringFrame,
  bumpChatRecoveryProgress,
  cleanupStreamBuffers,
  createChatFiberSnapshot,
  pendingChatTerminal,
  readChatRecoveryProgress,
  recordChatTerminal,
  resolveChatRecoveryConfig,
  runChatRecoveryExhaustion,
  sendIfOpen,
  setChatRecovering,
  shouldCreditStreamProgress,
  StreamProgressCreditThrottle,
  sweepStaleChatRecoveryIncidents,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot,
  CHAT_MESSAGE_TYPES,
  type ChatFiberWakeHooks,
  type ChatRecoveryAdapter,
  type ChatRecoveryConfig,
  type ChatRecoveryIncident,
  type ChatRecoveryIncidentEvent,
  type ChatRecoveryOptions,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryScheduleReason,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type RecoveryPartial,
  type ResolvedRecoveryStream,
  type ResumeHandshakeHost,
  type SnapshotMessage
} from "agents/chat";
import { FauxTanStackModel } from "./faux-model";
import type { TurnModel, TurnProvider } from "./model";
import { createWorkersAiModel } from "./workers-ai-model";
import { tanStackRecoveryCodec } from "./tanstack-codec";

/** A durable transcript entry. `partial` flags a preserved orphaned partial. */
interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  partial: boolean;
}

/** The recovery-callback payload the agent schedules for itself. */
interface TanStackRecoveryData {
  originalRequestId?: string;
  incidentId?: string;
}

/** A continuation summary the e2e polls to prove continue-vs-regenerate. */
interface RecoverySummary {
  via: "continue" | "retry";
  /** Chars the recovered turn generated (the suffix on a continue). */
  generatedChars: number;
  /** Chars of the survived partial prefix (0 on a regenerate). */
  prefixChars: number;
}

/** No classification detail needed — `recoveryKind` captures continue vs retry. */
type TanStackClassify = undefined;

const RECOVERING_MESSAGE_TYPE = CHAT_MESSAGE_TYPES.CHAT_RECOVERING;
const RECOVERY_SUMMARY_KEY = "tanstack:recovery:summary";
// The durable `onChatRecovery` persist policy for the in-flight turn (default
// true). Stored at turn start so a cold-wake recovery (post-SIGKILL) reads the
// policy the engine's settled-tool gate is evaluated against.
const PERSIST_POLICY_KEY = "tanstack:recovery:persist-policy";
// Whether the partial the gate preserved carried a SETTLED tool result — the
// observable that proves the AG-UI-reconstructed `parts` drove the gate.
const PARTIAL_SETTLED_TOOL_KEY = "tanstack:recovery:partial-settled-tool";
// The model provider this turn ran under (`faux` default | `workers-ai`). Stored
// durably so a cold-wake recovery (post-SIGKILL) re-runs the SAME provider it
// crashed under rather than silently falling back to the faux model.
const PROVIDER_KEY = "tanstack:turn:provider";
// System guidance for the REAL provider only: force a long, multi-paragraph reply
// so the turn streams over several seconds — wide enough for a `wrangler dev`
// SIGKILL to land mid-stream (the faux model achieves this via its slow tick).
const WORKERS_AI_SYSTEM_PROMPT =
  "You are a verbose assistant. Always answer in at least six long, detailed " +
  "paragraphs (300+ words total). Do not stop early.";
// Appended after an assistant-prefill on a real-provider continuation: ask the
// model to resume the survived prefix rather than restart. The merge folds
// whatever it streams onto the prefix, so the continuation invariant holds even
// if a non-deterministic model doesn't resume perfectly.
const WORKERS_AI_CONTINUE_NUDGE =
  "Your previous response was cut off. Continue it from exactly where it " +
  "stopped. Do not repeat any earlier text; output only the remaining content.";
// Slow enough that a multi-token reply streams over several seconds, leaving a
// wide window for the e2e to SIGKILL `wrangler dev` MID-STREAM.
const STREAM_TOKENS_PER_SECOND = 4;
// A long, deterministic reply body so the streamed turn lasts long enough to be
// interrupted mid-flight. Regenerated identically on recovery.
const REPLY_FILLER = Array.from(
  { length: 40 },
  (_unused, i) => `segment-${i}`
).join(" ");

/** The deterministic assistant text a turn streams for a given user prompt. */
function replyFor(userText: string): string {
  return `tanstack reply to "${userText}": ${REPLY_FILLER}`;
}

export class TanStackAgent extends Agent<Env> {
  static readonly FIBER_PREFIX = "__cf_internal_tanstack_turn:";
  static readonly SNAPSHOT_KEY = "__cfTanStackFiberSnapshot";

  // Recovery is keyed off the live config; assigned as a class field (NOT in
  // onStart) so fiber recovery reads the configured budgets on a cold wake.
  chatRecovery: ChatRecoveryConfig = true;

  private readonly _resumableStream: ResumableStream;
  private readonly _codec = tanStackRecoveryCodec;
  /** Per-isolate throttle for crediting progress from streaming-content deltas
   *  (the shared `agents/chat` rule). */
  private readonly _streamProgressCredit = new StreamProgressCreditThrottle();
  private readonly _faux: FauxTanStackModel;
  // The provider for the in-flight turn; re-read from durable storage on a
  // cold-wake recovery so the recovered turn runs under the SAME model.
  private _activeProvider: TurnProvider = "faux";
  private _workersAiModelInstance?: TurnModel;
  private _transcript: TranscriptEntry[] = [];
  private _currentStreamId: string | null = null;
  private _activeChatRecoveryRootRequestId: string | undefined;
  private _engineInstance?: ChatRecoveryEngine;
  private _continuationTargetId: string | null = null;
  private _inRecoveryTurn = false;

  // ── Handshake host state (shared with the streaming/broadcast loop) ─────────
  private _pendingResumeConnections: Set<string> = new Set();
  private _continuation = new ContinuationState<Connection>();
  private _resumeHandshakeInstance: ResumeHandshake | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS tanstack_messages (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        role TEXT,
        text TEXT,
        partial INTEGER,
        created_at INTEGER
      )
    `;

    this._resumableStream = new ResumableStream(this.sql.bind(this));
    this._faux = new FauxTanStackModel(STREAM_TOKENS_PER_SECOND);
    this._transcript = this._loadTranscript();
  }

  // ── Transcript persistence ──────────────────────────────────────────────

  private _loadTranscript(): TranscriptEntry[] {
    const rows = this.sql<{
      id: string;
      role: string;
      text: string;
      partial: number | null;
    }>`
      SELECT id, role, text, partial FROM tanstack_messages ORDER BY seq ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      text: row.text,
      partial: row.partial === 1
    }));
  }

  private _appendMessage(
    role: "user" | "assistant",
    text: string,
    partial = false
  ): TranscriptEntry {
    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      role,
      text,
      partial
    };
    this._transcript.push(entry);
    this.sql`
      INSERT INTO tanstack_messages (id, seq, role, text, partial, created_at)
      VALUES (
        ${entry.id},
        ${this._transcript.length},
        ${role},
        ${text},
        ${partial ? 1 : 0},
        ${Date.now()}
      )
    `;
    return entry;
  }

  private _lastEntry(): TranscriptEntry | undefined {
    return this._transcript[this._transcript.length - 1];
  }

  /** Text of the last user message, or `null` when none is unanswered. */
  private _lastUserText(): string | null {
    for (let i = this._transcript.length - 1; i >= 0; i--) {
      const entry = this._transcript[i];
      if (entry.role === "user") return entry.text;
    }
    return null;
  }

  private _snapshotMessages(): SnapshotMessage[] {
    return this._transcript.map((entry) => ({
      id: entry.id,
      role: entry.role
    }));
  }

  private async _recordRecoverySummary(
    summary: RecoverySummary
  ): Promise<void> {
    await this.ctx.storage.put(RECOVERY_SUMMARY_KEY, summary);
  }

  /**
   * Preserve a reconstructed orphaned partial as a `partial` assistant entry —
   * the merge target the continuation folds its suffix onto. Idempotent. Records
   * whether the reconstructed `parts` carried a settled tool result, since this
   * method only runs when the engine's persist gate ALLOWED the partial — so a
   * recorded `true` here under a `{ persist: false }` policy is proof the
   * AG-UI-reconstructed settled tool work is exactly what kept the partial alive.
   */
  private async _persistOrphanedPartial(streamId: string): Promise<void> {
    if (this._lastEntry()?.partial) return;
    const bodies = this._resumableStream
      .getStreamChunks(streamId)
      .map((chunk) => chunk.body);
    const { text, hasSettledToolResults } =
      this._codec.toRecoveryPartial(bodies);
    if (hasSettledToolResults) {
      await this.ctx.storage.put(PARTIAL_SETTLED_TOOL_KEY, true);
    }
    if (!text) return;
    this._appendMessage("assistant", text, true);
  }

  /**
   * Fold the continuation's regenerated suffix onto the preserved partial: the
   * merged text is the survived prefix plus the suffix, and the entry is
   * promoted to a committed message.
   */
  private async _mergeContinuation(
    entryId: string,
    suffix: string
  ): Promise<void> {
    const entry = this._transcript.find(
      (candidate) => candidate.id === entryId
    );
    if (!entry) {
      this._appendMessage("assistant", suffix);
      return;
    }
    const prefix = entry.text;
    const merged = prefix + suffix;
    entry.text = merged;
    entry.partial = false;
    this.sql`
      UPDATE tanstack_messages SET text = ${merged}, partial = 0
      WHERE id = ${entryId}
    `;
    await this._recordRecoverySummary({
      via: "continue",
      generatedChars: suffix.length,
      prefixChars: prefix.length
    });
  }

  /** Promote a preserved partial whose prefix already equals the full reply. */
  private async _finalizePartial(entryId: string): Promise<void> {
    const entry = this._transcript.find(
      (candidate) => candidate.id === entryId
    );
    if (!entry) return;
    entry.partial = false;
    this.sql`UPDATE tanstack_messages SET partial = 0 WHERE id = ${entryId}`;
    await this._recordRecoverySummary({
      via: "continue",
      generatedChars: 0,
      prefixChars: entry.text.length
    });
  }

  // ── Model selection (faux default | real Workers AI) ───────────────────────

  /** The model the active provider resolves to. Faux is the shared default; the
   *  real Workers AI adapter is built lazily the first time a turn opts in. */
  private _model(): TurnModel {
    if (this._activeProvider === "workers-ai") {
      return (this._workersAiModelInstance ??= createWorkersAiModel(
        this.env.AI
      ));
    }
    return this._faux;
  }

  /**
   * Build the conversation for the REAL provider from the COMMITTED transcript
   * (preserved partials are excluded). On a continuation re-run, the survived
   * partial is appended as an assistant-prefill plus a nudge so the model
   * resumes rather than restarts — the engine's continuation, expressed through
   * a real prompt instead of the faux model's exact-suffix scripting. The faux
   * model ignores these messages entirely.
   */
  private _buildModelMessages(): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (const entry of this._transcript) {
      if (entry.partial) continue;
      messages.push({ role: entry.role, content: entry.text });
    }
    if (this._continuationTargetId) {
      const partial = this._transcript.find(
        (entry) => entry.id === this._continuationTargetId
      );
      if (partial && partial.text) {
        messages.push({ role: "assistant", content: partial.text });
        messages.push({ role: "user", content: WORKERS_AI_CONTINUE_NUDGE });
      }
    }
    return messages;
  }

  // ── Turn execution (fiber-wrapped so a mid-stream crash is recoverable) ─────

  private async _runTurn(
    requestId: string,
    continuation: boolean
  ): Promise<void> {
    const snapshot = createChatFiberSnapshot({
      kind: "tanstack-turn",
      requestId,
      recoveryRootRequestId: this._activeChatRecoveryRootRequestId ?? requestId,
      continuation,
      messages: this._snapshotMessages()
    });

    await this._runFiberWithStashWrapper(
      TanStackAgent.FIBER_PREFIX + requestId,
      async (_fiber: FiberContext) => {
        const isContinuation = this._continuationTargetId !== null;
        const messageId = crypto.randomUUID();
        const streamId = this._resumableStream.start(requestId, {
          continuation: isContinuation,
          messageId
        });
        this._currentStreamId = streamId;

        const usingWorkersAi = this._activeProvider === "workers-ai";
        let producedText = "";
        try {
          for await (const chunk of this._model().stream({
            threadId: this.name,
            runId: requestId,
            messageId,
            messages: usingWorkersAi ? this._buildModelMessages() : undefined,
            systemPrompt: usingWorkersAi ? WORKERS_AI_SYSTEM_PROMPT : undefined
          })) {
            const body = JSON.stringify(chunk);
            this._resumableStream.storeChunk(streamId, body);
            // Fixture: flush every chunk so the partial is reliably durable the
            // instant a SIGKILL lands. A batching buffer would otherwise drop
            // the last <10 chunks on crash.
            this._resumableStream.flushBuffer();
            if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
              producedText += chunk.delta;
            }
            // Live broadcast to every connection EXCEPT those pending a resume
            // ACK (they get the full replay on ACK instead of duplicate chunks).
            this._broadcastChunk(requestId, body, false);
            // Credit forward progress through the shared host-agnostic rule (the
            // same one `AIChatAgent`/`Think` use): a milestone always credits, a
            // streaming-content delta credits at most once per throttle window.
            if (
              shouldCreditStreamProgress({
                codec: this._codec,
                type: chunk.type,
                throttle: this._streamProgressCredit,
                now: Date.now()
              })
            ) {
              await bumpChatRecoveryProgress(this.ctx.storage);
            }
          }
        } finally {
          this._currentStreamId = null;
        }

        this._broadcastChunk(requestId, "", true);
        this._resumableStream.complete(streamId);
        this._pendingResumeConnections.clear();
        await this._commitAssistant(producedText);
      },
      {
        initialSnapshot: wrapChatFiberSnapshot(
          TanStackAgent.SNAPSHOT_KEY,
          snapshot,
          null
        ),
        wrapStash: (data) =>
          wrapChatFiberSnapshot(TanStackAgent.SNAPSHOT_KEY, snapshot, data)
      }
    );
  }

  /** Commit a finished turn: merge a continuation suffix, else append fresh. */
  private async _commitAssistant(text: string): Promise<void> {
    if (this._continuationTargetId) {
      await this._mergeContinuation(this._continuationTargetId, text);
      this._continuationTargetId = null;
      return;
    }
    this._appendMessage("assistant", text);
    if (this._inRecoveryTurn) {
      await this._recordRecoverySummary({
        via: "retry",
        generatedChars: text.length,
        prefixChars: 0
      });
    }
  }

  /** Broadcast a stream chunk frame, excluding connections pending a resume ACK. */
  private _broadcastChunk(
    requestId: string,
    body: string,
    done: boolean
  ): void {
    this.broadcast(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: requestId,
        body,
        done
      }),
      [...this._pendingResumeConnections]
    );
  }

  /**
   * Start a fresh user turn. `persist` sets the durable `onChatRecovery` policy
   * the engine's gate is evaluated against on a later crash (default true).
   * `withTool` scripts the faux model to settle a tool call before its text
   * body, so a mid-text-tail crash leaves a partial carrying a settled tool
   * result — the input that exercises the settled-tool persist override.
   */
  async startTurn(
    text: string,
    opts: {
      withTool?: boolean;
      persist?: boolean;
      provider?: TurnProvider;
    } = {}
  ): Promise<void> {
    const { withTool = false, persist = true, provider = "faux" } = opts;
    this._activeProvider = provider;
    this._appendMessage("user", text);
    await this.ctx.storage.put(PERSIST_POLICY_KEY, persist);
    await this.ctx.storage.put(PROVIDER_KEY, provider);
    await this.ctx.storage.delete(PARTIAL_SETTLED_TOOL_KEY);
    // Scripting is faux-only; the real provider streams a live, model-generated
    // reply from the conversation built in `_buildModelMessages`.
    if (provider === "faux") {
      this._faux.setNextTurnText(replyFor(text));
      if (withTool) {
        this._faux.setNextTurnToolCall({
          toolCallId: `call-${crypto.randomUUID().slice(0, 8)}`,
          toolName: "lookup",
          args: { query: text },
          result: `result for "${text}"`
        });
      }
    }
    await this._runTurn(crypto.randomUUID(), false);
  }

  /**
   * Re-run a recovered turn. With `continueFromPartial` and a preserved partial
   * at the tail, the turn CONTINUES from only the suffix after the survived
   * prefix; otherwise it regenerates the whole reply (no-partial fallback).
   */
  private async _resumeRecoveredTurn(
    data: TanStackRecoveryData | undefined,
    continueFromPartial: boolean
  ): Promise<void> {
    const previousRoot = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId = data?.originalRequestId;
    const incidentId = data?.incidentId;
    this._inRecoveryTurn = true;
    // Restore the provider the crashed turn ran under (cold wake loses memory).
    this._activeProvider =
      (await this.ctx.storage.get<TurnProvider>(PROVIDER_KEY)) ?? "faux";
    try {
      const userText = this._lastUserText();
      if (userText === null) {
        await this._engine().updateIncident(
          incidentId,
          "skipped",
          "no_unanswered_user_message"
        );
        return;
      }

      // Real provider: there is no canonical reply to slice, so continuation is
      // expressed as an assistant-prefill prompt (see `_buildModelMessages`).
      // Set the merge target; `_runTurn` streams the model's continuation, and
      // `_commitAssistant` folds it onto the survived prefix. With no partial we
      // simply regenerate the turn.
      if (this._activeProvider === "workers-ai") {
        const tail = this._lastEntry();
        const partial =
          continueFromPartial &&
          tail?.partial === true &&
          tail.role === "assistant" &&
          tail.text.length > 0
            ? tail
            : undefined;
        if (partial) this._continuationTargetId = partial.id;
        await this._runTurn(crypto.randomUUID(), true);
        await this._engine().updateIncident(incidentId, "completed");
        return;
      }

      const full = replyFor(userText);
      const tail = this._lastEntry();
      const partial =
        continueFromPartial &&
        tail?.partial === true &&
        tail.role === "assistant"
          ? tail
          : undefined;

      if (partial) {
        const prefix = partial.text;
        if (full.startsWith(prefix) && prefix.length < full.length) {
          // Continue: regenerate ONLY the suffix; merge folds it onto the prefix.
          this._continuationTargetId = partial.id;
          this._faux.setNextTurnText(full.slice(prefix.length));
        } else if (prefix === full) {
          // The whole reply already survived — just promote the partial.
          await this._finalizePartial(partial.id);
          await this._engine().updateIncident(incidentId, "completed");
          return;
        } else {
          // Not a clean prefix (shouldn't happen with per-chunk flush) — fall
          // back to a fresh regenerate.
          this._faux.setNextTurnText(full);
        }
      } else {
        this._faux.setNextTurnText(full);
      }

      await this._runTurn(crypto.randomUUID(), true);
      await this._engine().updateIncident(incidentId, "completed");
    } catch (error) {
      this._continuationTargetId = null;
      await this._engine().updateIncident(
        incidentId,
        "failed",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    } finally {
      this._inRecoveryTurn = false;
      this._activeChatRecoveryRootRequestId = previousRoot;
    }
  }

  // ── Scheduled recovery callbacks (engine-driven) ────────────────────────────

  async _chatRecoveryRetry(data?: TanStackRecoveryData): Promise<void> {
    await this._resumeRecoveredTurn(data, false);
  }

  async _chatRecoveryContinue(data?: TanStackRecoveryData): Promise<void> {
    await this._resumeRecoveredTurn(data, true);
  }

  // ── WebSocket wiring: drive the shared ResumeHandshake ──────────────────────

  override async onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    if (this._resumableStream.hasActiveStream()) {
      // Proactively notify a connecting client about a resumable stream.
      this._resumeHandshake().notifyStreamResuming(connection);
    } else {
      // No active stream but a recovery may be in progress (between attempts):
      // replay the live "recovering…" status so a client connecting mid-recovery
      // reads the turn as working rather than frozen (#1620).
      const recoveringFrame = await buildChatRecoveringFrame(
        this.ctx.storage,
        RECOVERING_MESSAGE_TYPE,
        Date.now()
      );
      if (recoveringFrame) {
        sendIfOpen(connection, JSON.stringify(recoveringFrame));
      }
    }
    await super.onConnect(connection, ctx);
  }

  override async onMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<void> {
    if (typeof message !== "string") {
      return super.onMessage(connection, message);
    }
    let event: { type?: string; id?: string; text?: string } | null = null;
    try {
      event = JSON.parse(message);
    } catch {
      return super.onMessage(connection, message);
    }
    if (!event || typeof event.type !== "string") {
      return super.onMessage(connection, message);
    }

    switch (event.type) {
      case CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST:
        await this._resumeHandshake().handleResumeRequest(connection);
        return;
      case CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK:
        await this._resumeHandshake().handleResumeAck(
          connection,
          event.id ?? ""
        );
        return;
      case "tanstack-run":
        // The TanStack `SubscribeConnectionAdapter.send()` pushed a run. The
        // text is the latest user message (the bridge sends it as `text`).
        void this.startTurn(event.text ?? "hello tanstack");
        return;
      default:
        return super.onMessage(connection, message);
    }
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this._pendingResumeConnections.delete(connection.id);
    this._continuation.releaseConnection(connection.id);
    await super.onClose(connection, code, reason, wasClean);
  }

  private _resumeHandshake(): ResumeHandshake {
    return (this._resumeHandshakeInstance ??= new ResumeHandshake(
      this._resumeHandshakeHost()
    ));
  }

  private _resumeHandshakeHost(): ResumeHandshakeHost {
    return {
      responseMessageType: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      resumableStream: this._resumableStream,
      continuation: this._continuation,
      pendingResumeConnections: this._pendingResumeConnections,
      pendingChatTerminal: () => pendingChatTerminal(this.ctx.storage),
      persistOrphanedStream: async (streamId) => {
        await this._persistOrphanedPartial(streamId);
      }
    };
  }

  // ── Fiber recovery entry: drive the shared engine ───────────────────────────

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    return this._engine().handleChatFiberRecovery<TanStackClassify>(
      ctx,
      this._wakeHooks()
    );
  }

  private _wakeHooks(): ChatFiberWakeHooks<TanStackClassify> {
    return {
      chatFiberPrefix: () => TanStackAgent.FIBER_PREFIX,
      unwrapRecoverySnapshot: (ctx) => {
        const { snapshot, user } = unwrapChatFiberSnapshot(
          TanStackAgent.SNAPSHOT_KEY,
          ctx.snapshot,
          "tanstack-turn"
        );
        return { snapshot, recoveryData: user };
      },
      classifyRecoveredTurn: (input: ClassifyRecoveredTurnInput) => {
        // A surviving partial drives a `continue`; an empty partial (crash
        // before the first delta flushed) falls back to a `retry`.
        const recoveryKind =
          input.partial.text.length > 0
            ? ("continue" as const)
            : ("retry" as const);
        return { recoveryKind, detail: undefined };
      },
      invokeOnChatRecovery: async (): Promise<ChatRecoveryOptions> => {
        // The user-configurable `onChatRecovery` policy. A `{ persist: false }`
        // return would normally DROP the orphaned partial — but the engine's
        // shared settled-tool clause overrides it when the reconstructed parts
        // carry a settled (non-idempotent) tool result (#1631). Read from durable
        // storage so a cold-wake recovery honors the policy set at turn start.
        const persist =
          (await this.ctx.storage.get<boolean>(PERSIST_POLICY_KEY)) ?? true;
        return { persist };
      },
      shouldPersistOrphanedPartial: (input) => input.streamStillActive,
      persistOrphanedStream: async (streamId) => {
        await this._persistOrphanedPartial(streamId);
      },
      completeRecoveredStream: (streamId) => {
        this._resumableStream.complete(streamId);
      },
      dispatchRecoveredTurn: async (
        input: DispatchRecoveredTurnInput<TanStackClassify>
      ) => {
        const continueFromPartial = input.recoveryKind === "continue";
        await this._engine().scheduleRecovery({
          incident: input.incident,
          recoveryKind: input.recoveryKind,
          callback: continueFromPartial
            ? "_chatRecoveryContinue"
            : "_chatRecoveryRetry",
          data: {
            originalRequestId: input.recoveryRootRequestId,
            incidentId: input.incident.incidentId
          }
        });
      }
    };
  }

  // ── Shared engine adapter ───────────────────────────────────────────────────

  private _engine(): ChatRecoveryEngine {
    return (this._engineInstance ??= new ChatRecoveryEngine(this._adapter()));
  }

  private _resolveStreamId(requestId: string): string {
    const meta = this._resumableStream
      .getAllStreamMetadata()
      .find((row) => row.request_id === requestId);
    return meta?.id ?? this._resumableStream.activeStreamId ?? "";
  }

  /** Set/clear the live "recovering…" status (#1620), building the shared
   *  `setChatRecovering` option bag once so the adapter hook and the give-up
   *  terminalize share it. */
  private _setChatRecovering(
    active: boolean,
    requestId?: string
  ): Promise<void> {
    return setChatRecovering(active, requestId, {
      storage: this.ctx.storage,
      messageType: RECOVERING_MESSAGE_TYPE,
      broadcast: (frame) => this.broadcast(JSON.stringify(frame)),
      now: Date.now()
    });
  }

  private _adapter(): ChatRecoveryAdapter {
    return {
      resolveConfig: () => resolveChatRecoveryConfig(this.chatRecovery),
      now: () => Date.now(),
      sweepStaleIncidents: (now) =>
        sweepStaleChatRecoveryIncidents(this.ctx.storage, now),
      getIncident: (key) =>
        this.ctx.storage
          .get<ChatRecoveryIncident>(key)
          .then((value) => value ?? null),
      readProgress: () => readChatRecoveryProgress(this.ctx.storage),
      putIncident: (key, incident) => this.ctx.storage.put(key, incident),
      deleteIncident: (key) => this.ctx.storage.delete(key).then(() => {}),
      emitRecoveryEvent: (event: ChatRecoveryIncidentEvent) =>
        this._emit(event.type, { ...event }),
      scheduleRecovery: async (
        callback: ChatRecoveryScheduleCallback,
        data: Record<string, unknown>,
        reason: ChatRecoveryScheduleReason,
        delaySeconds: number
      ) => {
        await this.schedule(delaySeconds, callback, data, {
          idempotent: reason === "initial"
        });
      },
      setRecovering: (active, requestId) =>
        this._setChatRecovering(active, requestId),
      onShouldKeepRecoveringError: (error) =>
        console.error("[tanstack-recovery] shouldKeepRecovering threw", error),
      exhaustChatRecovery: (incident, config, partial, streamId, createdAt) =>
        runChatRecoveryExhaustion(
          {
            incident,
            config,
            partialText: partial.text,
            // The harness has no AI-SDK `UIMessage` parts (its parts are AG-UI
            // native, opaque to the engine); the exhausted-context parts surface
            // is AI-SDK-typed, so pass empty rather than fabricating one.
            partialParts: [],
            streamId,
            createdAt
          },
          {
            emit: (recoveryCtx) =>
              this._emit("chat:recovery:exhausted", { ...recoveryCtx }),
            onError: (error) =>
              console.error("[tanstack-recovery] onExhausted threw", error),
            terminalize: async (recoveryCtx) => {
              await recordChatTerminal(
                this.ctx.storage,
                recoveryCtx.recoveryRootRequestId ?? recoveryCtx.requestId,
                recoveryCtx.terminalMessage
              );
              await this._setChatRecovering(false, recoveryCtx.requestId);
            }
          }
        ),
      resolveRecoveryStream: (requestId): ResolvedRecoveryStream => {
        const streamId = this._resolveStreamId(requestId);
        return {
          streamId,
          streamStillActive:
            streamId !== "" && streamId === this._resumableStream.activeStreamId
        };
      },
      getPartialStreamText: (streamId): RecoveryPartial =>
        this._codec.toRecoveryPartial(
          this._resumableStream
            .getStreamChunks(streamId)
            .map((chunk) => chunk.body)
        ),
      activeChatRecoveryRootRequestId: () =>
        this._activeChatRecoveryRootRequestId,
      onGiveUpBookkeepingError: (phase, error) =>
        console.error(`[tanstack-recovery] give-up ${phase} error`, error)
    };
  }

  /** Stream-buffer cleanup alarm target (scheduled by ResumableStream cleanup). */
  async _cleanupStreamBuffers(): Promise<void> {
    await cleanupStreamBuffers(this._resumableStream, async () => {});
  }

  // ── Inspection surface (server HTTP → e2e assertions) ───────────────────────

  async getStatus(): Promise<{
    transcript: Array<{ role: string; text: string }>;
    assistantCount: number;
    fiberRows: number;
    incidentCount: number;
    recovering: boolean;
    progress: number;
    recoveredVia: "continue" | "retry" | null;
    recoveryGeneratedChars: number;
    partialPrefixChars: number;
    persistPolicy: boolean;
    partialHadSettledTool: boolean;
    bufferedChars: number;
  }> {
    const fiberRows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    // Chars currently reconstructable from the ACTIVE stream buffer — lets the
    // real-provider e2e wait until content has actually streamed (past the
    // model's time-to-first-token) before SIGKILLing, so the survived partial is
    // non-empty and recovery takes the `continue` path.
    const activeStreamId = this._resumableStream.activeStreamId;
    const bufferedChars = activeStreamId
      ? this._codec.toRecoveryPartial(
          this._resumableStream
            .getStreamChunks(activeStreamId)
            .map((chunk) => chunk.body)
        ).text.length
      : 0;
    const incidents = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    const recovering = await this.ctx.storage.get("cf:chat:recovering");
    const summary =
      await this.ctx.storage.get<RecoverySummary>(RECOVERY_SUMMARY_KEY);
    return {
      transcript: this._transcript.map((entry) => ({
        role: entry.role,
        text: entry.text
      })),
      assistantCount: this._transcript.filter(
        (entry) => entry.role === "assistant" && !entry.partial
      ).length,
      fiberRows: fiberRows[0].count,
      incidentCount: incidents.size,
      recovering: recovering !== undefined,
      progress: await readChatRecoveryProgress(this.ctx.storage),
      recoveredVia: summary?.via ?? null,
      recoveryGeneratedChars: summary?.generatedChars ?? 0,
      partialPrefixChars: summary?.prefixChars ?? 0,
      persistPolicy:
        (await this.ctx.storage.get<boolean>(PERSIST_POLICY_KEY)) ?? true,
      partialHadSettledTool:
        (await this.ctx.storage.get<boolean>(PARTIAL_SETTLED_TOOL_KEY)) ??
        false,
      bufferedChars
    };
  }
}
