import type { EventBus } from "../../../kernel/events.js";
import type { IdSource } from "../../../kernel/ids.js";
import type { Clock } from "../../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../../ports/storage.js";
import type { ConversationTurnState } from "../../conversation/turn-state.js";
import type { ConversationEvent } from "../../events/log.js";
import type { FiberRecoveryContext, FiberRecoveryResult, FiberService } from "../../runtime/fibers/fibers.js";
import { assistantMessage, type ChatMessage, type MessagePart, type ToolPart } from "../../messages/model.js";
import type { Session } from "../../session/session.js";
import type { TurnOutcome } from "../../turn/loop.js";

/**
 * Chat recovery (audit 14 §1): makes a turn survive process eviction and
 * stream stalls. Every recoverable turn runs inside a plain fiber named
 * "chat-turn" so an eviction mid-run leaves a durable row behind; on the
 * next activation the fiber service replays that row through
 * `onFiberRecovered`, which decides retry / continue / exhaust / skip.
 */

/** Fiber name every recoverable turn runs under (see module doc above). */
const FIBER_NAME = "chat-turn";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_TERMINAL_MESSAGE =
  "Sorry, I wasn't able to finish that response after multiple attempts. Please try again.";

/**
 * A JSON-serializable snapshot of the turn input, durable enough to survive
 * eviction and re-drive a retry.
 */
export interface TurnInputSnapshot {
  requestId: string;
  messages?: ChatMessage[];
  channelId?: string;
  trigger?: string;
}

export interface RecoveryPolicy {
  maxAttempts?: number;
  terminalMessage?: string;
  onExhausted?: (incident: Incident) => void | Promise<void>;
}

export interface Incident {
  incidentId: string;
  requestId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: "retry" | "continue";
}

export interface RecoverySchedule {
  requestId: string;
  incidentId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: Incident["recoveryKind"];
  scheduledAt: number;
}

export interface ChatRecovery {
  /** Wrap a turn execution in a recoverable fiber. */
  runRecoverable(args: {
    requestId: string;
    input: TurnInputSnapshot;
    execute: (signal: AbortSignal) => Promise<TurnOutcome>;
  }): Promise<TurnOutcome>;
  /** Fiber-recovery entry: decide skip/retry/continue/exhaust. */
  onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult>;
  handleStall(requestId: string): Promise<"recovering" | "terminal">;
  /** Drives the recovering broadcast (cf_agent_chat_recovering). */
  isRecovering(): boolean;
  /** Durable active incident rows, for read-only adapter/test inspection. */
  incidents(): Incident[];
  /** Recovery attempts currently scheduled or in flight. */
  scheduledRecoveries(): RecoverySchedule[];
  /** Resolves when no recovery attempt is scheduled or in flight. */
  waitUntilStable(): Promise<void>;
}

/** The subset of the stashed fiber snapshot this module cares about. */
interface ChatTurnSnapshot {
  requestId: string;
}

function isChatTurnSnapshot(value: unknown): value is ChatTurnSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { requestId?: unknown }).requestId === "string"
  );
}

export function createChatRecovery(deps: {
  store: KeyValueStore;
  fibers: FiberService;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  policy?: RecoveryPolicy;
  /**
   * The conversation seam (audit 26 §1). Recovery owns the full meaning of
   * its decisions — what "continue" is (commit the repaired partial, then
   * re-run) and what "terminalize" is (persist the terminal assistant
   * message) — so the composition root only supplies state access and two
   * narrow callbacks.
   */
  conversation: {
    turnState: ConversationTurnState;
    session(): Promise<Session>;
    /** Read at decision time so a subclass-assigned repair hook is honored. */
    repairPart?(): ((part: ToolPart) => MessagePart) | undefined;
    /** Publish a client-visible conversation event (message:updated). */
    publish(event: ConversationEvent): void;
    /**
     * Enqueue the recovery turn (continuation-flagged, same requestId).
     * Must not block on the turn finishing — it may be called from within
     * the currently-running turn (stall path), and awaiting completion
     * would deadlock the turn queue.
     */
    scheduleTurn(incident: Incident): void | Promise<void>;
    /** App-level terminal notification (onChatError etc.); the terminal
        message is already persisted when this fires. */
    onTerminal?(incident: Incident, terminalText: string): void | Promise<void>;
  };
}): ChatRecovery {
  const { fibers, bus, ids, conversation } = deps;
  const policy = deps.policy ?? {};
  const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const terminalMessage = policy.terminalMessage ?? DEFAULT_TERMINAL_MESSAGE;

  const kv = scoped(deps.store, "recover:");
  const incidentKey = (requestId: string): string => `incident:${requestId}`;
  const inputKey = (requestId: string): string => `input:${requestId}`;
  const recoveringKey = (requestId: string): string => `recovering:${requestId}`;
  let stableWaiters: Array<() => void> = [];

  function getIncident(requestId: string): Incident | undefined {
    return kv.get<Incident>(incidentKey(requestId));
  }

  function putIncident(incident: Incident): void {
    kv.put(incidentKey(incident.requestId), incident);
  }

  function clearIncident(requestId: string): void {
    kv.delete(incidentKey(requestId));
  }

  // The input snapshot is stored for diagnostics/inspection; a retry re-runs
  // from persisted session history (messages are appended before the fiber
  // starts), so nothing reads it back on the happy path.
  function putInputIfAbsent(input: TurnInputSnapshot): void {
    if (kv.get(inputKey(input.requestId)) === undefined) {
      kv.put(inputKey(input.requestId), input);
    }
  }

  function clearInput(requestId: string): void {
    kv.delete(inputKey(requestId));
  }

  function notifyIfStable(): void {
    if (isRecovering()) return;
    const waiters = stableWaiters;
    stableWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function setRecovering(incident: Incident, value: true): void;
  function setRecovering(requestId: string, value: false): void;
  function setRecovering(value: Incident | string, active: boolean): void {
    if (active) {
      const incident = value as Incident;
      const schedule: RecoverySchedule = { ...incident, scheduledAt: deps.clock.now() };
      kv.put(recoveringKey(incident.requestId), schedule);
    } else {
      kv.delete(recoveringKey(value as string));
      notifyIfStable();
    }
  }

  function isRecovering(): boolean {
    return kv.list<unknown>({ prefix: "recovering:" }).size > 0;
  }

  function incidents(): Incident[] {
    return [...kv.list<Incident>({ prefix: "incident:" }).values()];
  }

  function scheduledRecoveries(): RecoverySchedule[] {
    const rows: RecoverySchedule[] = [];
    for (const [key, raw] of kv.list<unknown>({ prefix: "recovering:" })) {
      if (isRecoverySchedule(raw)) {
        rows.push(raw);
        continue;
      }
      const requestId = key.slice("recovering:".length);
      const incident = getIncident(requestId);
      if (incident) rows.push({ ...incident, scheduledAt: 0 });
    }
    return rows;
  }

  function waitUntilStable(): Promise<void> {
    if (!isRecovering()) return Promise.resolve();
    return new Promise((resolve) => {
      stableWaiters.push(resolve);
    });
  }

  /**
   * Shared decision path for both an interrupted-fiber recovery and a
   * stalled-stream recovery: validate the conversation still matches, then
   * schedule a retry/continuation or terminalize on exhaustion.
   */
  /**
   * Terminalize: persist the terminal assistant message ourselves — the
   * composition root only gets notified. Recording it as the request's
   * partial keeps `partialFor` consistent for late observers.
   */
  async function terminalize(incident: Incident): Promise<void> {
    const session = await conversation.session();
    const terminalMsg = assistantMessage([{ type: "text", text: terminalMessage }], ids.newId("msg"));
    await session.appendMessage(terminalMsg);
    conversation.turnState.recordPartial(incident.requestId, terminalMsg);
    conversation.publish({ type: "message:updated", message: terminalMsg, requestId: incident.requestId });
    if (conversation.onTerminal) await conversation.onTerminal(incident, terminalMessage);
  }

  async function decide(
    requestId: string,
    opts: { forceContinue?: boolean },
  ): Promise<"scheduled" | "exhausted" | "skipped"> {
    bus.emit("chat:recovery:detected", { requestId });

    if (conversation.turnState.lastRequestId() !== requestId) {
      bus.emit("chat:recovery:skipped", { requestId, reason: "conversation_changed" });
      clearIncident(requestId);
      clearInput(requestId);
      setRecovering(requestId, false);
      return "skipped";
    }

    const existing = getIncident(requestId);
    const attempt = (existing?.attempt ?? 0) + 1;
    const incidentId = existing?.incidentId ?? ids.newId("incident");

    if (attempt > maxAttempts) {
      const incident: Incident = {
        incidentId,
        requestId,
        attempt,
        maxAttempts,
        recoveryKind: existing?.recoveryKind ?? "retry",
      };
      await terminalize(incident);
      if (policy.onExhausted) await policy.onExhausted(incident);
      bus.emit("chat:recovery:exhausted", { requestId, incidentId, attempt, maxAttempts });
      clearIncident(requestId);
      clearInput(requestId);
      setRecovering(requestId, false);
      return "exhausted";
    }

    const hasPartial = opts.forceContinue === true || conversation.turnState.partialFor(requestId) !== undefined;
    const recoveryKind: Incident["recoveryKind"] = hasPartial ? "continue" : "retry";
    const incident: Incident = { incidentId, requestId, attempt, maxAttempts, recoveryKind };
    putIncident(incident);
    setRecovering(incident, true);

    if (recoveryKind === "continue") {
      // What "continue" MEANS lives here: the interrupted partial only exists
      // in turn-state scratch (the turn never reached its normal persist), so
      // commit the repaired partial to history first — otherwise the re-run
      // is indistinguishable from a retry and the streamed text is lost.
      const session = await conversation.session();
      const repaired = await conversation.turnState.commitInterruptedPartial(
        requestId,
        session,
        conversation.repairPart?.(),
      );
      if (repaired) {
        conversation.publish({ type: "message:updated", message: repaired, requestId });
      }
    }
    await conversation.scheduleTurn(incident);

    bus.emit("chat:recovery:scheduled", { requestId, incidentId, attempt, recoveryKind });
    return "scheduled";
  }

  async function runRecoverable(args: {
    requestId: string;
    input: TurnInputSnapshot;
    execute: (signal: AbortSignal) => Promise<TurnOutcome>;
  }): Promise<TurnOutcome> {
    const { requestId, input, execute } = args;
    putInputIfAbsent(input);

    const existing = getIncident(requestId);
    if (existing) {
      bus.emit("chat:recovery:attempt", {
        requestId,
        incidentId: existing.incidentId,
        attempt: existing.attempt,
      });
    }

    const outcome = await fibers.run(FIBER_NAME, async (ctx) => {
      ctx.stash({
        requestId,
        incidentId: existing?.incidentId,
        attempt: existing?.attempt ?? 1,
        phase: "running",
      });
      return execute(ctx.signal);
    });

    if (outcome.kind === "completed") {
      if (existing) {
        bus.emit("chat:recovery:completed", {
          requestId,
          incidentId: existing.incidentId,
          attempt: existing.attempt,
        });
      }
      clearIncident(requestId);
      clearInput(requestId);
      setRecovering(requestId, false);
    }

    return outcome;
  }

  async function onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    if (ctx.name !== FIBER_NAME) return undefined;
    if (!isChatTurnSnapshot(ctx.snapshot)) return undefined;

    await decide(ctx.snapshot.requestId, {});
    return undefined;
  }

  async function handleStall(requestId: string): Promise<"recovering" | "terminal"> {
    const result = await decide(requestId, { forceContinue: true });
    return result === "scheduled" ? "recovering" : "terminal";
  }

  return {
    runRecoverable,
    onFiberRecovered,
    handleStall,
    isRecovering,
    incidents,
    scheduledRecoveries,
    waitUntilStable,
  };
}

function isRecoverySchedule(value: unknown): value is RecoverySchedule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { requestId?: unknown }).requestId === "string" &&
    typeof (value as { incidentId?: unknown }).incidentId === "string" &&
    typeof (value as { attempt?: unknown }).attempt === "number" &&
    typeof (value as { maxAttempts?: unknown }).maxAttempts === "number" &&
    ((value as { recoveryKind?: unknown }).recoveryKind === "retry" ||
      (value as { recoveryKind?: unknown }).recoveryKind === "continue") &&
    typeof (value as { scheduledAt?: unknown }).scheduledAt === "number"
  );
}
