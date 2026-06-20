/**
 * `PiAgent` — the Phase-5 genericity harness.
 *
 * A Durable Object that drives the REAL `@earendil-works/pi-agent-core` `Agent`
 * (its real loop, real `continue()`, real `AgentEvent` stream) on top of the
 * SAME shared `ChatRecoveryEngine` that `AIChatAgent` and `Think` use. pi is a
 * non-AI-SDK consumer: its transcript is `Message[]` (`AgentMessage`), its
 * streaming surface is pi's `AgentEvent` vocabulary, and it has NO `UIMessage`.
 * If the engine recovers a deploy/crash mid-stream here with no `UIMessage`-
 * shaped assumption leaking through, the seam holds (rfc-chat-recovery-
 * foundation, Phase 5).
 *
 * Recovery model for a text-only pi turn (`stream_continuation`): a SIGKILL
 * mid-stream interrupts the fiber before `message_end` commits the assistant
 * message. The streamed deltas, however, were buffered durably (per-event) into
 * `ResumableStream` via {@link PiRecoveryCodec}. On wake the engine reconstructs
 * that partial through the codec, PRESERVES it (`persistOrphanedStream` commits
 * it as a partial assistant entry), classifies a `continue`, and re-runs the
 * turn through pi's real `continue()` priming the model with only the REMAINING
 * suffix — which merges onto the survived prefix to land the same full reply.
 * This mirrors the AI SDK adapter's continue path and Flue's
 * `recoverInterruptedStream`; the earlier "pi can only regenerate" framing was
 * an artifact of the first codec, NOT a pi constraint (see the RFC Phase-5 seam
 * note). The `retry`/full-regenerate path stays as the fallback when no partial
 * survived (crash before the first delta flushed).
 *
 * @internal Validation fixture, not a published package.
 */

import { Agent, type FiberContext, type FiberRecoveryContext } from "agents";
import {
  ChatRecoveryEngine,
  ResumableStream,
  bumpChatRecoveryProgress,
  cleanupStreamBuffers,
  createChatFiberSnapshot,
  readChatRecoveryProgress,
  recordChatTerminal,
  resolveChatRecoveryConfig,
  runChatRecoveryExhaustion,
  setChatRecovering,
  sweepStaleChatRecoveryIncidents,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot,
  type ChatFiberWakeHooks,
  type ChatRecoveryAdapter,
  type ChatRecoveryConfig,
  type ChatRecoveryIncident,
  type ChatRecoveryIncidentEvent,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryScheduleReason,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type RecoveryPartial,
  type ResolvedRecoveryStream,
  type SnapshotMessage
} from "agents/chat";
import { Agent as PiCore } from "@earendil-works/pi-agent-core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  TextContent,
  UserMessage
} from "@earendil-works/pi-ai";
import { PiRecoveryCodec, renderAssistantText } from "./pi-codec";
import { createFauxPiModel, type FauxPiModel } from "./pi-model";

export type Env = {
  PiAgent: DurableObjectNamespace<PiAgent>;
};

/**
 * A durable transcript entry: a stable id paired with a real pi message.
 * `partial` flags a reconstructed-but-not-yet-finished assistant message (the
 * preserved orphaned partial) — excluded from pi's model context until the
 * continuation merges its suffix and clears the flag.
 */
interface TranscriptEntry {
  id: string;
  message: Message;
  partial: boolean;
}

/** The recovery-callback payload pi schedules for itself. */
interface PiRecoveryData {
  originalRequestId?: string;
  incidentId?: string;
}

/**
 * pi carries no classification detail: whether the recovered turn CONTINUEs from
 * a survived partial vs regenerates from the unanswered user message is fully
 * captured by `recoveryKind` (`"continue"` vs `"retry"`), so dispatch derives it
 * rather than threading a redundant flag through `detail` (#5).
 */
type PiClassify = undefined;

/** A continuation summary the e2e polls to prove continue-vs-regenerate. */
interface RecoverySummary {
  via: "continue" | "retry";
  /** Chars the recovered turn generated (the suffix on a continue). */
  generatedChars: number;
  /** Chars of the survived partial prefix (0 on a regenerate). */
  prefixChars: number;
}

const RECOVERING_MESSAGE_TYPE = "pi:recovering";
const RECOVERY_SUMMARY_KEY = "pi:recovery:summary";
// Slow enough that a multi-token reply streams over several seconds, leaving a
// wide window for the e2e to SIGKILL `wrangler dev` MID-STREAM (before the turn
// commits its assistant message), exactly like the AI SDK e2e's slow mock.
const STREAM_TOKENS_PER_SECOND = 4;
// A long, deterministic reply body so the streamed turn lasts long enough to be
// interrupted mid-flight. Regenerated identically on recovery.
const REPLY_FILLER = Array.from(
  { length: 40 },
  (_unused, i) => `segment-${i}`
).join(" ");

/** The deterministic assistant text a turn streams for a given user prompt. */
function replyFor(userText: string): string {
  return `pi reply to "${userText}": ${REPLY_FILLER}`;
}

/**
 * Clone a real pi `AssistantMessage`, replacing its text with `text` (keeping
 * any non-text content). Reuses the captured message's required envelope
 * (`api`/`provider`/`model`/`usage`/`stopReason`/…) so the result stays a valid
 * pi message — never hand-built from scratch.
 */
function withText(message: AssistantMessage, text: string): AssistantMessage {
  const head: TextContent = { type: "text", text };
  const nonText = message.content.filter((block) => block.type !== "text");
  return { ...message, content: [head, ...nonText] };
}

export class PiAgent extends Agent<Env> {
  static readonly FIBER_PREFIX = "__cf_internal_pi_turn:";
  static readonly SNAPSHOT_KEY = "__cfPiFiberSnapshot";

  // Recovery is keyed off the live config; assigned as a class field (NOT in
  // onStart) so fiber recovery reads the configured budgets on a cold wake.
  chatRecovery: ChatRecoveryConfig = true;

  private readonly _resumableStream: ResumableStream;
  private readonly _codec = new PiRecoveryCodec();
  private readonly _faux: FauxPiModel;
  private readonly _pi: PiCore;
  private _transcript: TranscriptEntry[] = [];
  private _currentStreamId: string | null = null;
  private _activeChatRecoveryRootRequestId: string | undefined;
  private _engineInstance?: ChatRecoveryEngine;
  // When set, the in-flight turn is a continuation: its committed assistant
  // message merges its suffix ONTO this preserved-partial entry instead of
  // appending a fresh entry.
  private _continuationTargetId: string | null = null;
  // True while a recovery-driven turn runs, so the regenerate (no-partial) path
  // records its summary; cleared in the `finally`.
  private _inRecoveryTurn = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS pi_messages (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        role TEXT,
        body TEXT,
        partial INTEGER,
        created_at INTEGER
      )
    `;

    this._resumableStream = new ResumableStream(this.sql.bind(this));
    this._faux = createFauxPiModel({
      tokensPerSecond: STREAM_TOKENS_PER_SECOND
    });
    this._transcript = this._loadTranscript();

    this._pi = new PiCore({
      initialState: {
        model: this._faux.model,
        systemPrompt: "You are a deterministic pi recovery harness.",
        messages: this._piMessages()
      }
    });

    // Mirror pi's committed assistant messages into the durable transcript +
    // buffer the streaming events for crash recovery.
    this._pi.subscribe(async (event) => {
      await this._onPiEvent(event);
    });
  }

  // ── Transcript persistence ────────────────────────────────────────────────

  private _loadTranscript(): TranscriptEntry[] {
    const rows = this.sql<{ id: string; body: string; partial: number | null }>`
      SELECT id, body, partial FROM pi_messages ORDER BY seq ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.body) as Message,
      partial: row.partial === 1
    }));
  }

  private _appendMessage(message: Message, partial = false): TranscriptEntry {
    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      message,
      partial
    };
    this._transcript.push(entry);
    this.sql`
      INSERT INTO pi_messages (id, seq, role, body, partial, created_at)
      VALUES (
        ${entry.id},
        ${this._transcript.length},
        ${message.role},
        ${JSON.stringify(message)},
        ${partial ? 1 : 0},
        ${Date.now()}
      )
    `;
    return entry;
  }

  private _lastEntry(): TranscriptEntry | undefined {
    return this._transcript[this._transcript.length - 1];
  }

  /**
   * The messages pi's loop sees — committed entries only. A preserved partial
   * assistant is excluded so the user message stays the leaf and pi GENERATES
   * the continuation suffix (an assistant leaf would end the loop); the merge
   * then folds that suffix back onto the partial.
   */
  private _piMessages(): Message[] {
    return this._transcript
      .filter((entry) => !entry.partial)
      .map((entry) => entry.message);
  }

  /** Text of the last user message, or `null` when none is unanswered. */
  private _lastUserText(): string | null {
    for (let i = this._transcript.length - 1; i >= 0; i--) {
      const message = this._transcript[i].message;
      if (message.role === "user") return this._messageText(message);
    }
    return null;
  }

  private _snapshotMessages(): SnapshotMessage[] {
    return this._transcript.map((entry) => ({
      id: entry.id,
      role: entry.message.role
    }));
  }

  /**
   * Resolve the durable stream id for a turn's `requestId`: the metadata row if
   * one survived, else the live active stream, else `""`. Backs the single
   * `ChatRecoveryAdapter.resolveRecoveryStream` seam, which the engine drives on
   * both the wake and give-up paths (the two-seam duplication noted in the RFC
   * Phase-5 API-ergonomics findings is now collapsed).
   */
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

  private async _recordRecoverySummary(
    summary: RecoverySummary
  ): Promise<void> {
    await this.ctx.storage.put(RECOVERY_SUMMARY_KEY, summary);
  }

  /**
   * Preserve a reconstructed orphaned partial as a `partial` assistant entry —
   * the merge target the continuation folds its suffix onto. Idempotent: a
   * partial already at the tail (an earlier wake preserved it) stays put.
   */
  private _persistOrphanedPartial(streamId: string): void {
    if (this._lastEntry()?.partial) return;
    const bodies = this._resumableStream
      .getStreamChunks(streamId)
      .map((chunk) => chunk.body);
    const { text, message } = this._codec.decodePartial(bodies);
    if (!text || !message) return;
    this._appendMessage(withText(message, text), true);
  }

  /**
   * Fold the continuation's committed assistant message onto the preserved
   * partial `entryId`: the merged text is the survived prefix plus the
   * regenerated suffix, and the entry is promoted to a committed message.
   */
  private async _mergeContinuation(
    entryId: string,
    continuation: AssistantMessage
  ): Promise<void> {
    const entry = this._transcript.find(
      (candidate) => candidate.id === entryId
    );
    if (!entry || entry.message.role !== "assistant") {
      this._appendMessage(continuation);
      return;
    }
    const prefix = renderAssistantText(entry.message);
    const suffix = renderAssistantText(continuation);
    const merged = withText(continuation, prefix + suffix);
    entry.message = merged;
    entry.partial = false;
    this.sql`
      UPDATE pi_messages SET body = ${JSON.stringify(merged)}, partial = 0
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
    this.sql`UPDATE pi_messages SET partial = 0 WHERE id = ${entryId}`;
    await this._recordRecoverySummary({
      via: "continue",
      generatedChars: 0,
      prefixChars:
        entry.message.role === "assistant"
          ? renderAssistantText(entry.message).length
          : 0
    });
  }

  // ── pi event handling ─────────────────────────────────────────────────────

  private async _onPiEvent(event: AgentEvent): Promise<void> {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const assistant = event.message as AssistantMessage;
      if (this._continuationTargetId) {
        await this._mergeContinuation(this._continuationTargetId, assistant);
        this._continuationTargetId = null;
      } else {
        this._appendMessage(assistant);
        if (this._inRecoveryTurn) {
          await this._recordRecoverySummary({
            via: "retry",
            generatedChars: renderAssistantText(assistant).length,
            prefixChars: 0
          });
        }
      }
    }

    const body = this._codec.encodeEvent(event);
    if (body && this._currentStreamId) {
      this._resumableStream.storeChunk(this._currentStreamId, body);
      // Fixture: flush every delta so the partial is reliably durable the
      // instant a SIGKILL lands (the engine reconstructs + continues from it).
      // A batching buffer would otherwise drop the last <10 chunks on crash.
      this._resumableStream.flushBuffer();
      // Each durably-flushed streaming event is reconnect-immune forward
      // progress for the no-progress recovery budget.
      await bumpChatRecoveryProgress(this.ctx.storage);
    }
  }

  // ── Turn execution (fiber-wrapped so a mid-stream crash is recoverable) ─────

  private async _runPiTurn(
    requestId: string,
    continuation: boolean
  ): Promise<void> {
    const snapshot = createChatFiberSnapshot({
      kind: "pi-turn",
      requestId,
      recoveryRootRequestId: this._activeChatRecoveryRootRequestId ?? requestId,
      continuation,
      messages: this._snapshotMessages()
    });

    await this._runFiberWithStashWrapper(
      PiAgent.FIBER_PREFIX + requestId,
      async (_fiber: FiberContext) => {
        // Sync pi's live context from the durable mirror (committed entries
        // only — a preserved partial is excluded so the user stays the leaf and
        // pi generates the continuation suffix).
        this._pi.state.messages = this._piMessages();
        const streamId = this._resumableStream.start(requestId, {
          continuation: this._continuationTargetId !== null
        });
        this._currentStreamId = streamId;
        try {
          await this._pi.continue();
        } finally {
          this._currentStreamId = null;
        }
        this._resumableStream.complete(streamId);
      },
      {
        initialSnapshot: wrapChatFiberSnapshot(
          PiAgent.SNAPSHOT_KEY,
          snapshot,
          null
        ),
        wrapStash: (data) =>
          wrapChatFiberSnapshot(PiAgent.SNAPSHOT_KEY, snapshot, data)
      }
    );
  }

  /** Start a fresh user turn. */
  async startTurn(text: string): Promise<void> {
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now()
    };
    this._appendMessage(userMessage);
    this._faux.setNextTurnText(replyFor(text));
    await this._runPiTurn(crypto.randomUUID(), false);
  }

  /**
   * Re-run a recovered turn. With `continueFromPartial` and a preserved partial
   * at the tail, the turn CONTINUES: the model is primed with only the suffix
   * remaining after the survived prefix, which `_mergeContinuation` folds back
   * onto the partial (`stream_continuation`). Otherwise it regenerates the whole
   * reply from the unanswered user message (the no-partial fallback).
   */
  private async _resumeRecoveredTurn(
    data: PiRecoveryData | undefined,
    continueFromPartial: boolean
  ): Promise<void> {
    const previousRoot = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId = data?.originalRequestId;
    const incidentId = data?.incidentId;
    this._inRecoveryTurn = true;
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
      const full = replyFor(userText);
      const tail = this._lastEntry();
      const partial =
        continueFromPartial &&
        tail?.partial === true &&
        tail.message.role === "assistant"
          ? tail
          : undefined;

      if (partial) {
        const prefix = renderAssistantText(partial.message as AssistantMessage);
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
          // Prefix is not a clean prefix of the reply (shouldn't happen with
          // per-event flush) — fall back to a fresh regenerate.
          this._faux.setNextTurnText(full);
        }
      } else {
        this._faux.setNextTurnText(full);
      }

      await this._runPiTurn(crypto.randomUUID(), true);
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

  private _messageText(message: Message): string {
    if (message.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => ("text" in block ? block.text : ""))
            .join("");
    }
    return "";
  }

  // ── Scheduled recovery callbacks (engine-driven) ────────────────────────────

  async _chatRecoveryRetry(data?: PiRecoveryData): Promise<void> {
    await this._resumeRecoveredTurn(data, false);
  }

  async _chatRecoveryContinue(data?: PiRecoveryData): Promise<void> {
    await this._resumeRecoveredTurn(data, true);
  }

  // ── Fiber recovery entry: drive the shared engine ───────────────────────────

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    return this._engine().handleChatFiberRecovery<PiClassify>(
      ctx,
      this._wakeHooks()
    );
  }

  private _wakeHooks(): ChatFiberWakeHooks<PiClassify> {
    return {
      chatFiberPrefix: () => PiAgent.FIBER_PREFIX,
      unwrapRecoverySnapshot: (ctx) => {
        const { snapshot, user } = unwrapChatFiberSnapshot(
          PiAgent.SNAPSHOT_KEY,
          ctx.snapshot,
          "pi-turn"
        );
        return { snapshot, recoveryData: user };
      },
      classifyRecoveredTurn: (input: ClassifyRecoveredTurnInput) => {
        // A surviving partial drives a `continue` (regenerate only the suffix
        // and merge); an empty partial (crash before the first delta flushed)
        // falls back to a `retry` that regenerates the whole reply.
        const recoveryKind =
          input.partial.text.length > 0
            ? ("continue" as const)
            : ("retry" as const);
        return { recoveryKind, detail: undefined };
      },
      // `invokeOnChatRecovery` is omitted: pi exposes no user `onChatRecovery`
      // hook, so the engine's default (empty options) applies (#6).
      // Mirror the AI SDK adapter: preserve the orphaned partial whenever its
      // (restored) stream is still the active in-flight one. The engine ANDs
      // this with the shared never-drop clause.
      shouldPersistOrphanedPartial: (input) => input.streamStillActive,
      persistOrphanedStream: async (streamId) => {
        this._persistOrphanedPartial(streamId);
      },
      completeRecoveredStream: (streamId) => {
        this._resumableStream.complete(streamId);
      },
      dispatchRecoveredTurn: async (
        input: DispatchRecoveredTurnInput<PiClassify>
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
      // `isAwaitingClientInteraction` is omitted: pi has no client tools / HITL,
      // so the engine's default (`false`, never parked on a human) applies (#6).
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
        console.error("[pi-recovery] shouldKeepRecovering threw", error),
      exhaustChatRecovery: (incident, config, partial, streamId, createdAt) =>
        runChatRecoveryExhaustion(
          {
            incident,
            config,
            partialText: partial.text,
            // Pi has no AI-SDK `UIMessage` parts (text-only); the
            // exhausted-context parts surface is AI-SDK-typed, so pass empty
            // rather than fabricating.
            partialParts: [],
            streamId,
            createdAt
          },
          {
            emit: (ctx) => this._emit("chat:recovery:exhausted", { ...ctx }),
            onError: (error) =>
              console.error("[pi-recovery] onExhausted threw", error),
            terminalize: async (ctx) => {
              await recordChatTerminal(
                this.ctx.storage,
                ctx.recoveryRootRequestId ?? ctx.requestId,
                ctx.terminalMessage
              );
              await this._setChatRecovering(false, ctx.requestId);
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
        console.error(`[pi-recovery] give-up ${phase} error`, error)
    };
  }

  /** Stream-buffer cleanup alarm target (scheduled by ResumableStream cleanup). */
  async _cleanupStreamBuffers(): Promise<void> {
    await cleanupStreamBuffers(this._resumableStream, async () => {});
  }

  // ── Inspection surface (server stub RPC → e2e assertions) ───────────────────

  /** Snapshot of recovery-relevant state for the e2e to poll. */
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
  }> {
    const fiberRows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    const incidents = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    const recovering = await this.ctx.storage.get("cf:chat:recovering");
    const summary =
      await this.ctx.storage.get<RecoverySummary>(RECOVERY_SUMMARY_KEY);
    return {
      transcript: this._transcript.map((entry) => ({
        role: entry.message.role,
        text: this._renderEntryText(entry.message)
      })),
      assistantCount: this._transcript.filter(
        (entry) => entry.message.role === "assistant" && !entry.partial
      ).length,
      fiberRows: fiberRows[0].count,
      incidentCount: incidents.size,
      recovering: recovering !== undefined,
      progress: await readChatRecoveryProgress(this.ctx.storage),
      recoveredVia: summary?.via ?? null,
      recoveryGeneratedChars: summary?.generatedChars ?? 0,
      partialPrefixChars: summary?.prefixChars ?? 0
    };
  }

  private _renderEntryText(message: Message): string {
    return message.role === "assistant"
      ? renderAssistantText(message)
      : this._messageText(message);
  }
}
