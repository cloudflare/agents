import { describe, expect, it, vi } from "vitest";
import type { ResolvedChatRecoveryConfig } from "../lifecycle";
import {
  AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS,
  AgentToolStreamProgressThrottle,
  bumpChatRecoveryProgress,
  CHAT_RECOVERY_ALARM_DEBOUNCE_MS,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  CHAT_RECOVERY_INCIDENT_TTL_MS,
  CHAT_RECOVERY_PROGRESS_KEY,
  chatRecoveryIncidentId,
  chatRecoveryIncidentKey,
  DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
  DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
  evaluateChatRecoveryIncident,
  KV_DELETE_MAX_KEYS,
  readChatRecoveryProgress,
  resolveChatRecoveryConfig,
  selectStaleIncidentKeys,
  sweepStaleChatRecoveryIncidents,
  type ChatRecoveryIncident
} from "../recovery-incident";

/**
 * Layer-1 shared engine unit tests (rfc-chat-recovery-foundation, Phase 0).
 *
 * These characterize the durable recovery incident state machine directly,
 * with a deterministic clock and a deterministic progress counter, with no AI
 * SDK streams, WebSockets, or real Durable Object storage. They are the
 * contract the extracted engine must satisfy and a faithful copy of the
 * behavior currently inlined in `AIChatAgent._beginChatRecoveryIncident` and
 * `Think._beginChatRecoveryIncident`.
 */

const T0 = 1_700_000_000_000;

function config(
  overrides: Partial<ResolvedChatRecoveryConfig> = {}
): ResolvedChatRecoveryConfig {
  return {
    enabled: true,
    maxAttempts: DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
    stableTimeoutMs: 10_000,
    terminalMessage: DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
    noProgressTimeoutMs: DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
    maxRecoveryWork: Number.POSITIVE_INFINITY,
    ...overrides
  };
}

const identity = {
  requestId: "req-1",
  recoveryRootRequestId: "root-1",
  latestUserMessageId: "user-1",
  recoveryKind: "continue" as const
};

function evaluate(
  overrides: Partial<Parameters<typeof evaluateChatRecoveryIncident>[0]> = {}
) {
  return evaluateChatRecoveryIncident({
    identity,
    config: config(),
    existing: null,
    currentProgress: 0,
    awaitingClientInteraction: false,
    now: T0,
    ...overrides
  });
}

describe("chatRecoveryIncidentId", () => {
  it("joins recovery root and latest user message, excluding recovery kind", async () => {
    const asRetry = chatRecoveryIncidentId({
      ...identity,
      recoveryKind: "retry"
    });
    const asContinue = chatRecoveryIncidentId({
      ...identity,
      recoveryKind: "continue"
    });
    expect(asRetry).toBe("root-1:user-1");
    expect(asContinue).toBe(asRetry);
  });

  it("falls back to requestId when no recovery root is given", () => {
    expect(
      chatRecoveryIncidentId({
        requestId: "req-2",
        latestUserMessageId: "user-2",
        recoveryKind: "retry"
      })
    ).toBe("req-2:user-2");
  });

  it("tolerates a missing latest user message id", () => {
    expect(
      chatRecoveryIncidentId({ requestId: "req-3", recoveryKind: "retry" })
    ).toBe("req-3:");
  });
});

describe("chatRecoveryIncidentKey", () => {
  it("uses the cutover key prefix and URL-encodes the id", () => {
    expect(chatRecoveryIncidentKey("root-1:user-1")).toBe(
      `${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}root-1%3Auser-1`
    );
  });
});

describe("resolveChatRecoveryConfig", () => {
  it("treats `true` as enabled with built-in defaults", () => {
    expect(resolveChatRecoveryConfig(true)).toMatchObject({
      enabled: true,
      maxAttempts: DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
      noProgressTimeoutMs: DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
      maxRecoveryWork: Number.POSITIVE_INFINITY,
      terminalMessage: DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE
    });
  });

  it("treats `false` as disabled", () => {
    expect(resolveChatRecoveryConfig(false).enabled).toBe(false);
  });

  it("treats `undefined` as enabled (defaults)", () => {
    expect(resolveChatRecoveryConfig(undefined).enabled).toBe(true);
  });

  it("clamps and floors numeric overrides", () => {
    const resolved = resolveChatRecoveryConfig({
      maxAttempts: 0,
      stableTimeoutMs: -5,
      noProgressTimeoutMs: 1234.9
    });
    expect(resolved.maxAttempts).toBe(1);
    expect(resolved.stableTimeoutMs).toBe(0);
    expect(resolved.noProgressTimeoutMs).toBe(1234);
  });

  it("accepts a finite maxRecoveryWork including 0, rejects negatives", () => {
    expect(
      resolveChatRecoveryConfig({ maxRecoveryWork: 0 }).maxRecoveryWork
    ).toBe(0);
    expect(
      resolveChatRecoveryConfig({ maxRecoveryWork: -1 }).maxRecoveryWork
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("passes through shouldKeepRecovering and onExhausted when present", () => {
    const shouldKeepRecovering = vi.fn(() => true);
    const onExhausted = vi.fn();
    const resolved = resolveChatRecoveryConfig({
      shouldKeepRecovering,
      onExhausted
    });
    expect(resolved.shouldKeepRecovering).toBe(shouldKeepRecovering);
    expect(resolved.onExhausted).toBe(onExhausted);
  });
});

describe("selectStaleIncidentKeys", () => {
  it("selects only incidents inactive past the TTL", () => {
    const fresh: ChatRecoveryIncident = {
      incidentId: "a",
      requestId: "a",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 10,
      status: "attempting",
      firstSeenAt: T0,
      lastAttemptAt: T0
    };
    const stale: ChatRecoveryIncident = {
      ...fresh,
      incidentId: "b",
      requestId: "b",
      lastAttemptAt: T0 - CHAT_RECOVERY_INCIDENT_TTL_MS - 1
    };
    const entries = new Map<string, ChatRecoveryIncident | undefined>([
      ["key-a", fresh],
      ["key-b", stale],
      ["key-c", undefined]
    ]);
    expect(selectStaleIncidentKeys(entries, T0)).toEqual(["key-b", "key-c"]);
  });
});

/**
 * Minimal in-memory Durable Object storage fake for the shared sweep + progress
 * helpers. Records `list`/`delete` calls so the batching contract can be asserted.
 */
class FakeStorage {
  readonly data = new Map<string, unknown>();
  readonly listPrefixes: string[] = [];
  readonly deleteBatches: string[][] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    this.listPrefixes.push(options.prefix);
    const out = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (key.startsWith(options.prefix)) out.set(key, value as T);
    }
    return out;
  }

  async delete(keys: string[]): Promise<number> {
    this.deleteBatches.push(keys);
    let removed = 0;
    for (const key of keys) {
      if (this.data.delete(key)) removed++;
    }
    return removed;
  }
}

function staleIncident(id: string, now: number): ChatRecoveryIncident {
  return {
    incidentId: id,
    requestId: id,
    recoveryKind: "continue",
    attempt: 1,
    maxAttempts: 10,
    status: "attempting",
    firstSeenAt: now - CHAT_RECOVERY_INCIDENT_TTL_MS - 1,
    lastAttemptAt: now - CHAT_RECOVERY_INCIDENT_TTL_MS - 1
  };
}

describe("sweepStaleChatRecoveryIncidents", () => {
  it("lists by the incident prefix and deletes only stale incidents", async () => {
    const storage = new FakeStorage();
    storage.data.set(`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}stale`, {
      ...staleIncident("stale", T0)
    });
    storage.data.set(`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}fresh`, {
      ...staleIncident("fresh", T0),
      lastAttemptAt: T0
    });
    // An unrelated key outside the prefix must never be touched.
    storage.data.set("cf:chat:last-terminal", { foo: 1 });

    await sweepStaleChatRecoveryIncidents(
      storage as unknown as Pick<DurableObjectStorage, "list" | "delete">,
      T0
    );

    expect(storage.listPrefixes).toEqual([CHAT_RECOVERY_INCIDENT_KEY_PREFIX]);
    expect(storage.deleteBatches).toEqual([
      [`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}stale`]
    ]);
    expect(storage.data.has(`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}fresh`)).toBe(
      true
    );
    expect(storage.data.has("cf:chat:last-terminal")).toBe(true);
  });

  it("makes no delete call when nothing is stale", async () => {
    const storage = new FakeStorage();
    storage.data.set(`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}fresh`, {
      ...staleIncident("fresh", T0),
      lastAttemptAt: T0
    });

    await sweepStaleChatRecoveryIncidents(
      storage as unknown as Pick<DurableObjectStorage, "list" | "delete">,
      T0
    );

    expect(storage.deleteBatches).toEqual([]);
  });

  it("batches deletes into KV_DELETE_MAX_KEYS-sized chunks", async () => {
    const storage = new FakeStorage();
    const total = KV_DELETE_MAX_KEYS * 2 + 5;
    for (let i = 0; i < total; i++) {
      storage.data.set(
        `${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${i}`,
        staleIncident(String(i), T0)
      );
    }

    await sweepStaleChatRecoveryIncidents(
      storage as unknown as Pick<DurableObjectStorage, "list" | "delete">,
      T0
    );

    expect(storage.deleteBatches.map((batch) => batch.length)).toEqual([
      KV_DELETE_MAX_KEYS,
      KV_DELETE_MAX_KEYS,
      5
    ]);
    expect(storage.data.size).toBe(0);
  });
});

describe("readChatRecoveryProgress / bumpChatRecoveryProgress", () => {
  it("reads 0 when the counter is unset", async () => {
    const storage = new FakeStorage();
    expect(
      await readChatRecoveryProgress(
        storage as unknown as Pick<DurableObjectStorage, "get">
      )
    ).toBe(0);
  });

  it("monotonically increments the durable counter", async () => {
    const storage = new FakeStorage();
    const typed = storage as unknown as Pick<
      DurableObjectStorage,
      "get" | "put"
    >;
    await bumpChatRecoveryProgress(typed);
    await bumpChatRecoveryProgress(typed);
    expect(await readChatRecoveryProgress(typed)).toBe(2);
    expect(storage.data.get(CHAT_RECOVERY_PROGRESS_KEY)).toBe(2);
  });
});

describe("AgentToolStreamProgressThrottle", () => {
  // Production `now` is always a large epoch (`Date.now()`) ≫ the throttle
  // window, so a fresh isolate (`_lastBumpAt = 0`) always credits its first
  // forwarded chunk; use epoch-scale timestamps to match that.
  it("credits the first call (fresh isolate) and throttles within the window", () => {
    const throttle = new AgentToolStreamProgressThrottle();
    expect(throttle.shouldCredit(T0)).toBe(true);
    expect(
      throttle.shouldCredit(
        T0 + AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS - 1
      )
    ).toBe(false);
  });

  it("credits again once the window has elapsed", () => {
    const throttle = new AgentToolStreamProgressThrottle();
    expect(throttle.shouldCredit(T0)).toBe(true);
    expect(
      throttle.shouldCredit(T0 + AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS)
    ).toBe(true);
  });
});

describe("evaluateChatRecoveryIncident", () => {
  it("opens an incident for an orphaned chat fiber", async () => {
    const { incident, exhausted, events } = await evaluate();
    expect(exhausted).toBe(false);
    expect(incident).toMatchObject({
      incidentId: "root-1:user-1",
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      recoveryKind: "continue",
      attempt: 1,
      status: "attempting",
      firstSeenAt: T0,
      lastAttemptAt: T0,
      workBaseline: 0,
      progress: 0
    });
    expect(events.map((e) => e.type)).toEqual([
      "chat:recovery:detected",
      "chat:recovery:attempt"
    ]);
  });

  it("emits attempt without detected for an existing incident", async () => {
    const existing = (await evaluate()).incident;
    const { events } = await evaluate({
      existing,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(events.map((e) => e.type)).toEqual(["chat:recovery:attempt"]);
  });

  it("shares budget when retry becomes continue (identity excludes kind)", async () => {
    const first = (
      await evaluate({ identity: { ...identity, recoveryKind: "retry" } })
    ).incident;
    expect(first.attempt).toBe(1);
    const second = await evaluate({
      identity: { ...identity, recoveryKind: "continue" },
      existing: first,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    // Same incident id, attempt advanced under one budget, kind updated.
    expect(second.incident.incidentId).toBe(first.incidentId);
    expect(second.incident.attempt).toBe(2);
    expect(second.incident.recoveryKind).toBe("continue");
  });

  it("does not burn attempts inside the deploy debounce window", async () => {
    const first = (await evaluate()).incident;
    const second = await evaluate({
      existing: first,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS - 1
    });
    expect(second.incident.attempt).toBe(1);
    expect(second.exhausted).toBe(false);
  });

  it("advances attempts outside the debounce window", async () => {
    const first = (await evaluate()).incident;
    const second = await evaluate({
      existing: first,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(second.incident.attempt).toBe(2);
  });

  it("resets attempts to 1 after adapter-reported progress", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 7,
      progress: 3,
      workBaseline: 0,
      lastProgressAt: T0
    };
    const { incident } = await evaluate({
      existing,
      currentProgress: 5, // > existing.progress => made progress
      now: T0 + 10 * CHAT_RECOVERY_ALARM_DEBOUNCE_MS
    });
    expect(incident.attempt).toBe(1);
    expect(incident.lastProgressAt).toBe(
      T0 + 10 * CHAT_RECOVERY_ALARM_DEBOUNCE_MS
    );
    expect(incident.progress).toBe(5);
  });

  it("exhausts on the attempt cap with max_attempts_exceeded", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 10,
      maxAttempts: 10,
      lastProgressAt: T0
    };
    const { incident, exhausted } = await evaluate({
      existing,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(incident.attempt).toBe(11);
    expect(exhausted).toBe(true);
    expect(incident.status).toBe("exhausted");
    expect(incident.reason).toBe("max_attempts_exceeded");
  });

  it("exhausts on the no-progress timeout", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 2,
      lastProgressAt: T0
    };
    const { incident, exhausted } = await evaluate({
      existing,
      now: T0 + DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS + 1
    });
    expect(exhausted).toBe(true);
    expect(incident.reason).toBe("no_progress_timeout");
  });

  it("exhausts on a finite work budget with work_budget_exceeded", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 2,
      workBaseline: 0,
      progress: 0,
      lastProgressAt: T0
    };
    const { incident, exhausted } = await evaluate({
      existing,
      config: config({ maxRecoveryWork: 2 }),
      currentProgress: 3, // work = 3 - 0 = 3 > 2
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(exhausted).toBe(true);
    expect(incident.reason).toBe("work_budget_exceeded");
  });

  it("does not exhaust progressing work when maxRecoveryWork is Infinity", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 2,
      workBaseline: 0,
      progress: 100,
      lastProgressAt: T0
    };
    const { exhausted } = await evaluate({
      existing,
      currentProgress: 1_000_000,
      now: T0 + 1_000
    });
    expect(exhausted).toBe(false);
  });

  it("keeps recovering when shouldKeepRecovering returns true", async () => {
    const existing = (await evaluate()).incident;
    const { exhausted } = await evaluate({
      existing,
      config: config({ shouldKeepRecovering: () => true }),
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(exhausted).toBe(false);
  });

  it("aborts when shouldKeepRecovering returns false", async () => {
    const existing = (await evaluate()).incident;
    const { incident, exhausted } = await evaluate({
      existing,
      config: config({ shouldKeepRecovering: () => false }),
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(exhausted).toBe(true);
    expect(incident.reason).toBe("recovery_aborted");
  });

  it("treats a throwing shouldKeepRecovering as keep-recovering and reports the error", async () => {
    const existing = (await evaluate()).incident;
    const onShouldKeepRecoveringError = vi.fn();
    const { exhausted } = await evaluate({
      existing,
      config: config({
        shouldKeepRecovering: () => {
          throw new Error("boom");
        }
      }),
      onShouldKeepRecoveringError,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(exhausted).toBe(false);
    expect(onShouldKeepRecoveringError).toHaveBeenCalledOnce();
  });

  it("does not consult shouldKeepRecovering on first detection", async () => {
    const shouldKeepRecovering = vi.fn(() => false);
    const { exhausted } = await evaluate({
      existing: null,
      config: config({ shouldKeepRecovering })
    });
    expect(shouldKeepRecovering).not.toHaveBeenCalled();
    expect(exhausted).toBe(false);
  });

  it("lets the no-progress timeout win before the predicate", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 2,
      lastProgressAt: T0
    };
    const shouldKeepRecovering = vi.fn(() => true);
    const { incident } = await evaluate({
      existing,
      config: config({ shouldKeepRecovering }),
      now: T0 + DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS + 1
    });
    expect(shouldKeepRecovering).not.toHaveBeenCalled();
    expect(incident.reason).toBe("no_progress_timeout");
  });

  it("lets the work budget win before the predicate", async () => {
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 2,
      workBaseline: 0,
      progress: 0,
      lastProgressAt: T0
    };
    const shouldKeepRecovering = vi.fn(() => true);
    const { incident } = await evaluate({
      existing,
      config: config({ maxRecoveryWork: 1, shouldKeepRecovering }),
      currentProgress: 5,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(shouldKeepRecovering).not.toHaveBeenCalled();
    expect(incident.reason).toBe("work_budget_exceeded");
  });

  it("is budget-free while awaiting a client interaction", async () => {
    // An incident already at the attempt cap, well past the no-progress window,
    // must NOT exhaust while a client interaction is pending.
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 10,
      maxAttempts: 10,
      lastProgressAt: T0
    };
    const shouldKeepRecovering = vi.fn(() => false);
    const { incident, exhausted } = await evaluate({
      existing,
      config: config({ shouldKeepRecovering, maxRecoveryWork: 0 }),
      awaitingClientInteraction: true,
      currentProgress: 50,
      now: T0 + 10 * DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS
    });
    expect(exhausted).toBe(false);
    expect(incident.status).toBe("attempting");
    expect(shouldKeepRecovering).not.toHaveBeenCalled();
    // No-progress clock kept fresh so the turn has a full window once answered.
    expect(incident.lastProgressAt).toBe(
      T0 + 10 * DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS
    );
  });

  it("captures the work baseline on the opening attempt", async () => {
    const { incident } = await evaluate({ currentProgress: 4 });
    expect(incident.workBaseline).toBe(4);
    expect(incident.progress).toBe(4);
  });
});
