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
 * Recovery model for a text-only pi turn: a SIGKILL mid-stream interrupts the
 * fiber before `message_end` commits the assistant message, so the last durable
 * transcript entry is the unanswered USER message. On wake the engine classifies
 * a `retry` and re-runs the turn through pi's real `continue()` — which
 * regenerates the assistant response (deterministic via the faux provider). pi
 * has no settled tool results, so the orphaned partial is regenerated rather
 * than persisted; this divergence from the AI SDK adapter (which merges the
 * partial) is the recorded Tier-2 seam difference.
 *
 * @internal Validation fixture, not a published package.
 */

import { Agent, type FiberContext, type FiberRecoveryContext } from "agents";
import {
  ChatRecoveryEngine,
  ResumableStream,
  buildChatRecoveryExhaustedContext,
  bumpChatRecoveryProgress,
  cleanupStreamBuffers,
  createChatFiberSnapshot,
  notifyChatRecoveryExhausted,
  readChatRecoveryProgress,
  recordChatTerminal,
  resolveChatRecoveryConfig,
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
  UserMessage
} from "@earendil-works/pi-ai";
import { PiRecoveryCodec } from "./pi-codec";
import { createFauxPiModel, type FauxPiModel } from "./pi-model";

export type Env = {
  PiAgent: DurableObjectNamespace<PiAgent>;
};

/** A durable transcript entry: a stable id paired with a real pi message. */
interface TranscriptEntry {
  id: string;
  message: Message;
}

/** The recovery-callback payload pi schedules for itself. */
interface PiRecoveryData {
  originalRequestId?: string;
  incidentId?: string;
  targetUserId?: string;
}

/** pi's per-turn classification detail (text-only: always a regenerate retry). */
type PiClassify = { regenerate: boolean };

const RECOVERING_MESSAGE_TYPE = "pi:recovering";
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS pi_messages (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        role TEXT,
        body TEXT,
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
        messages: this._transcript.map((entry) => entry.message)
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
    const rows = this.sql<{ id: string; body: string }>`
      SELECT id, body FROM pi_messages ORDER BY seq ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.body) as Message
    }));
  }

  private _appendMessage(message: Message): TranscriptEntry {
    const entry: TranscriptEntry = { id: crypto.randomUUID(), message };
    this._transcript.push(entry);
    this.sql`
      INSERT INTO pi_messages (id, seq, role, body, created_at)
      VALUES (
        ${entry.id},
        ${this._transcript.length},
        ${message.role},
        ${JSON.stringify(message)},
        ${Date.now()}
      )
    `;
    return entry;
  }

  private _lastEntry(): TranscriptEntry | undefined {
    return this._transcript[this._transcript.length - 1];
  }

  private _snapshotMessages(): SnapshotMessage[] {
    return this._transcript.map((entry) => ({
      id: entry.id,
      role: entry.message.role
    }));
  }

  // ── pi event handling ─────────────────────────────────────────────────────

  private async _onPiEvent(event: AgentEvent): Promise<void> {
    if (event.type === "message_end" && event.message.role === "assistant") {
      this._appendMessage(event.message as AssistantMessage);
    }

    const body = this._codec.encodeEvent(event);
    if (body && this._currentStreamId) {
      this._resumableStream.storeChunk(this._currentStreamId, body);
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
        // Sync pi's live transcript from the durable mirror so continue()
        // regenerates from exactly what survived the crash.
        this._pi.state.messages = this._transcript.map(
          (entry) => entry.message
        );
        const streamId = this._resumableStream.start(requestId);
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

  /** Re-run an unanswered user turn (recovery regenerate). */
  private async _resumeRecoveredTurn(data?: PiRecoveryData): Promise<void> {
    const previousRoot = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId = data?.originalRequestId;
    const incidentId = data?.incidentId;
    try {
      const last = this._lastEntry();
      if (!last || last.message.role !== "user") {
        await this._engine().updateIncident(
          incidentId,
          "skipped",
          "no_unanswered_user_message"
        );
        return;
      }
      // Re-prime the deterministic reply so the regenerated turn produces the
      // same content the crashed turn was streaming.
      const userText = this._messageText(last.message);
      this._faux.setNextTurnText(replyFor(userText));
      await this._runPiTurn(crypto.randomUUID(), true);
      await this._engine().updateIncident(incidentId, "completed");
    } catch (error) {
      await this._engine().updateIncident(
        incidentId,
        "failed",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    } finally {
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
    await this._resumeRecoveredTurn(data);
  }

  async _chatRecoveryContinue(data?: PiRecoveryData): Promise<void> {
    await this._resumeRecoveredTurn(data);
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
      resolveRecoveryStream: (requestId): ResolvedRecoveryStream => {
        const meta = this._resumableStream
          .getAllStreamMetadata()
          .find((row) => row.request_id === requestId);
        const streamId = meta?.id ?? this._resumableStream.activeStreamId ?? "";
        return {
          streamId,
          streamStillActive:
            streamId !== "" && streamId === this._resumableStream.activeStreamId
        };
      },
      classifyRecoveredTurn: (_input: ClassifyRecoveredTurnInput) => ({
        // A text-only pi turn has no settled tool work and no mid-assistant
        // resume; recovery always regenerates the unanswered user turn.
        recoveryKind: "retry" as const,
        detail: { regenerate: true }
      }),
      invokeOnChatRecovery: async () => ({}),
      // pi regenerates rather than merging an orphaned partial (no settled
      // results to preserve), so the partial is never persisted.
      shouldPersistOrphanedPartial: () => false,
      persistOrphanedStream: async () => {},
      completeRecoveredStream: (streamId) => {
        this._resumableStream.complete(streamId);
      },
      dispatchRecoveredTurn: async (
        input: DispatchRecoveredTurnInput<PiClassify>
      ) => {
        await this._engine().scheduleRecovery({
          incident: input.incident,
          recoveryKind: "retry",
          callback: "_chatRecoveryRetry",
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
      // pi has no client tools / HITL: a turn is never parked on a human.
      isAwaitingClientInteraction: () => false,
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
        setChatRecovering(active, requestId, {
          storage: this.ctx.storage,
          messageType: RECOVERING_MESSAGE_TYPE,
          broadcast: (frame) => this.broadcast(JSON.stringify(frame)),
          now: Date.now()
        }),
      onShouldKeepRecoveringError: (error) =>
        console.error("[pi-recovery] shouldKeepRecovering threw", error),
      exhaustChatRecovery: async (
        incident,
        config,
        partial,
        streamId,
        createdAt
      ) => {
        const exhausted = buildChatRecoveryExhaustedContext({
          incident,
          config,
          partialText: partial.text,
          partialParts: partial.parts,
          streamId,
          createdAt
        });
        await notifyChatRecoveryExhausted(exhausted, {
          emit: (ctx) => this._emit("chat:recovery:exhausted", { ...ctx }),
          onError: (error) =>
            console.error("[pi-recovery] onExhausted threw", error)
        });
        await recordChatTerminal(
          this.ctx.storage,
          incident.recoveryRootRequestId ?? incident.requestId,
          exhausted.terminalMessage
        );
        await setChatRecovering(false, incident.requestId, {
          storage: this.ctx.storage,
          messageType: RECOVERING_MESSAGE_TYPE,
          broadcast: (frame) => this.broadcast(JSON.stringify(frame)),
          now: Date.now()
        });
      },
      resolveRecoveryStreamId: (requestId) => {
        const meta = this._resumableStream
          .getAllStreamMetadata()
          .find((row) => row.request_id === requestId);
        return meta?.id ?? this._resumableStream.activeStreamId ?? "";
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

  /** True while at least one orphaned fiber row survives (interrupted turn). */
  hasFiberRows(): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count > 0;
  }

  /** Snapshot of recovery-relevant state for the e2e to poll. */
  async getStatus(): Promise<{
    transcript: Array<{ role: string; text: string }>;
    assistantCount: number;
    fiberRows: number;
    incidentCount: number;
    recovering: boolean;
    progress: number;
  }> {
    const fiberRows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    const incidents = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    const recovering = await this.ctx.storage.get("cf:chat:recovering");
    return {
      transcript: this._transcript.map((entry) => ({
        role: entry.message.role,
        text: this._renderEntryText(entry.message)
      })),
      assistantCount: this._transcript.filter(
        (entry) => entry.message.role === "assistant"
      ).length,
      fiberRows: fiberRows[0].count,
      incidentCount: incidents.size,
      recovering: recovering !== undefined,
      progress: await readChatRecoveryProgress(this.ctx.storage)
    };
  }

  private _renderEntryText(message: Message): string {
    if (message.role === "assistant") {
      return message.content
        .filter((block) => block.type === "text")
        .map((block) => ("text" in block ? block.text : ""))
        .join("");
    }
    return this._messageText(message);
  }
}
