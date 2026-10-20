import { describe, expect, it, vi } from "vitest";
import type { ResolvedChatRecoveryConfig } from "../lifecycle";
import {
  AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS,
  AgentToolStreamProgressThrottle,
  bumpChatRecoveryProgress,
  CHAT_RECOVERY_ALARM_DEBOUNCE_MS,
  classifyAgentToolChildRecovery,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  CHAT_RECOVERY_INCIDENT_TTL_MS,
  CHAT_RECOVERY_PROGRESS_KEY,
  chatRecoveryIncidentId,
  chatRecoveryIncidentKey,
  DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
  DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS,
  DEFAULT_CHAT_RECOVERY_MAX_WORK,
  DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
  admitChatRecoveryAttempt,
  evaluateChatRecoveryIncident,
  finishChatRecoveryAttempt,
  KV_DELETE_MAX_KEYS,
  listActiveChatRecoveryIncidents,
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
    maxAttempts: DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
    stableTimeoutMs: 10_000,
    terminalMessage: DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
    noProgressTimeoutMs: DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
    maxRecoveryWork: Number.POSITIVE_INFINITY,
    maxInterruptedAttempts: DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS,
    ...overrides
  };
}

const identity = {
  requestId: "req-1",
  recoveryRootRequestId: "root-1",
  latestUserMessageId: "user-1",
  recoveryKind: "continue" as const
};

/** An `interrupted` trigger whose replay runs in `isolate`. */
function interrupted(isolate: string, token = "attempt-1") {
  return { kind: "interrupted" as const, attempt: { isolate, token } };
}

function evaluate(
  overrides: Partial<Parameters<typeof evaluateChatRecoveryIncident>[0]> = {}
) {
  return evaluateChatRecoveryIncident({
    identity,
    // A stall counts nothing, so tests about the other budgets are unaffected
    // by the interruption budget unless they opt in.
    trigger: { kind: "stalled" },
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
      maxAttempts: DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
      noProgressTimeoutMs: DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
      maxRecoveryWork: DEFAULT_CHAT_RECOVERY_MAX_WORK,
      maxInterruptedAttempts: DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS,
      terminalMessage: DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE
    });
  });

  it("treats legacy JavaScript `false` as enabled defaults", () => {
    // @ts-expect-error `false` is no longer accepted, but previously-compiled
    // JavaScript must safely get durable recovery instead of the removed mode.
    const resolved = resolveChatRecoveryConfig(false);
    expect(resolved).not.toHaveProperty("enabled");
    expect(resolved.maxAttempts).toBe(DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS);
  });

  it("treats `undefined` as enabled defaults", () => {
    expect(resolveChatRecoveryConfig(undefined)).not.toHaveProperty("enabled");
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

  it("accepts a finite maxRecoveryWork including 0, falls back to the default for negatives", () => {
    expect(
      resolveChatRecoveryConfig({ maxRecoveryWork: 0 }).maxRecoveryWork
    ).toBe(0);
    expect(
      resolveChatRecoveryConfig({ maxRecoveryWork: -1 }).maxRecoveryWork
    ).toBe(DEFAULT_CHAT_RECOVERY_MAX_WORK);
    // Integrators can still opt back into the pre-#1825 unbounded behavior.
    expect(
      resolveChatRecoveryConfig({ maxRecoveryWork: Number.POSITIVE_INFINITY })
        .maxRecoveryWork
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults maxInterruptedAttempts to 5, floors it, and keeps Infinity (#2613)", () => {
    expect(DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS).toBe(5);
    expect(resolveChatRecoveryConfig(true).maxInterruptedAttempts).toBe(5);
    expect(
      resolveChatRecoveryConfig({ maxInterruptedAttempts: 2.9 })
        .maxInterruptedAttempts
    ).toBe(2);
    // Sealing on the first interruption is the lowest meaningful budget.
    expect(
      resolveChatRecoveryConfig({ maxInterruptedAttempts: 0 })
        .maxInterruptedAttempts
    ).toBe(1);
    expect(
      resolveChatRecoveryConfig({ maxInterruptedAttempts: -1 })
        .maxInterruptedAttempts
    ).toBe(5);
    expect(
      resolveChatRecoveryConfig({
        maxInterruptedAttempts: Number.POSITIVE_INFINITY
      }).maxInterruptedAttempts
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads the deprecated maxOomRetries N as maxInterruptedAttempts N + 1", () => {
    // Three retries meant four attempts in total; the alias keeps that.
    expect(
      resolveChatRecoveryConfig({ maxOomRetries: 3 }).maxInterruptedAttempts
    ).toBe(4);
    expect(
      resolveChatRecoveryConfig({ maxOomRetries: 0 }).maxInterruptedAttempts
    ).toBe(1);
    expect(
      resolveChatRecoveryConfig({ maxOomRetries: -1 }).maxInterruptedAttempts
    ).toBe(5);
    // The new name wins when both are set.
    expect(
      resolveChatRecoveryConfig({ maxInterruptedAttempts: 2, maxOomRetries: 9 })
        .maxInterruptedAttempts
    ).toBe(2);
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

describe("listActiveChatRecoveryIncidents", () => {
  function seed(
    storage: FakeStorage,
    incidents: { id: string; status: ChatRecoveryIncident["status"] }[]
  ): void {
    for (const { id, status } of incidents) {
      storage.data.set(`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${id}`, {
        ...staleIncident(id, T0),
        status
      });
    }
  }

  it("returns only live incidents (detected/scheduled/attempting), not terminalized ones", async () => {
    const storage = new FakeStorage();
    seed(storage, [
      { id: "detected", status: "detected" },
      { id: "scheduled", status: "scheduled" },
      { id: "attempting", status: "attempting" },
      { id: "exhausted", status: "exhausted" },
      { id: "failed", status: "failed" }
    ]);
    // An unrelated key outside the prefix must never be returned.
    storage.data.set("cf:chat:last-terminal", { foo: 1 });

    const active = await listActiveChatRecoveryIncidents(
      storage as unknown as Pick<DurableObjectStorage, "list">
    );

    expect(storage.listPrefixes).toEqual([CHAT_RECOVERY_INCIDENT_KEY_PREFIX]);
    expect(active.map((a) => a.incident.incidentId).sort()).toEqual([
      "attempting",
      "detected",
      "scheduled"
    ]);
  });

  it("returns an empty list when nothing is live", async () => {
    const storage = new FakeStorage();
    seed(storage, [
      { id: "exhausted", status: "exhausted" },
      { id: "failed", status: "failed" }
    ]);

    const active = await listActiveChatRecoveryIncidents(
      storage as unknown as Pick<DurableObjectStorage, "list">
    );

    expect(active).toEqual([]);
  });
});

describe("classifyAgentToolChildRecovery", () => {
  function seed(
    storage: FakeStorage,
    statuses: ChatRecoveryIncident["status"][]
  ): void {
    statuses.forEach((status, i) => {
      storage.data.set(`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${i}`, {
        ...staleIncident(String(i), T0),
        status
      });
    });
  }

  const classify = (storage: FakeStorage) =>
    classifyAgentToolChildRecovery(
      storage as unknown as Pick<DurableObjectStorage, "list">
    );

  it("returns 'none' when there are no incidents", async () => {
    expect(await classify(new FakeStorage())).toBe("none");
  });

  it("returns 'none' when all incidents are completed/non-terminal-failure", async () => {
    const storage = new FakeStorage();
    seed(storage, ["completed", "completed"]);
    expect(await classify(storage)).toBe("none");
  });

  it("returns 'failed' when any incident is exhausted or failed (and none live)", async () => {
    const storage = new FakeStorage();
    seed(storage, ["completed", "exhausted", "failed"]);
    expect(await classify(storage)).toBe("failed");
  });

  it("returns 'in-progress' for a detected/scheduled/attempting incident", async () => {
    for (const live of ["detected", "scheduled", "attempting"] as const) {
      const storage = new FakeStorage();
      seed(storage, [live]);
      expect(await classify(storage)).toBe("in-progress");
    }
  });

  it("prioritizes 'in-progress' over 'failed' regardless of order", async () => {
    const storage = new FakeStorage();
    seed(storage, ["failed", "attempting", "exhausted"]);
    expect(await classify(storage)).toBe("in-progress");
  });

  it("lists by the incident prefix only", async () => {
    const storage = new FakeStorage();
    seed(storage, ["attempting"]);
    storage.data.set("cf:chat:last-terminal", { foo: 1 });
    await classify(storage);
    expect(storage.listPrefixes).toEqual([CHAT_RECOVERY_INCIDENT_KEY_PREFIX]);
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

  it("seals an OOM-style crash loop via the DEFAULT work budget (#1825)", async () => {
    // Regression for #1825: an isolate that OOMs mid-stream credits a little
    // progress before it dies, which resets the attempt cap and refreshes the
    // no-progress clock on every wake — and because each crash lands inside the
    // alarm-debounce window the attempt counter is pinned too. Neither
    // progress-keyed bound can ever fire. Before #1825 `maxRecoveryWork`
    // defaulted to Infinity, so the loop ran forever; now the generous finite
    // default is the one meter that still climbs and seals it.
    const defaults = resolveChatRecoveryConfig(true);
    const existing: ChatRecoveryIncident = {
      ...(await evaluate()).incident,
      attempt: 1,
      workBaseline: 0,
      progress: DEFAULT_CHAT_RECOVERY_MAX_WORK, // work accrued by the loop so far
      lastProgressAt: T0
    };
    const { incident, exhausted } = await evaluate({
      existing,
      config: defaults,
      // Fresh progress (crash streamed a bit more) AND inside the debounce
      // window — exactly the conditions that defeat the attempt + no-progress
      // bounds. work = (DEFAULT + 1) - 0 > DEFAULT.
      currentProgress: DEFAULT_CHAT_RECOVERY_MAX_WORK + 1,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS - 1
    });
    expect(incident.attempt).toBe(1); // attempt cap never advanced (reset on progress)
    expect(exhausted).toBe(true);
    expect(incident.reason).toBe("work_budget_exceeded");
  });

  it("seals a turn whose attempts keep dying, even when each streams output inside the debounce window (#2613)", async () => {
    // Each death leaves the attempt record of an isolate that is gone; the
    // next isolate's replay counts it. Every attempt streamed a little before
    // dying, which resets the attempt cap and the no-progress clock, and the
    // deaths come faster than the debounce window. Only the interruption
    // count still climbs.
    let existing: ChatRecoveryIncident | null = null;
    for (let death = 1; death <= 5; death++) {
      const { incident, exhausted } = await evaluate({
        trigger: interrupted(`isolate-${death}`),
        existing,
        currentProgress: death * 3,
        now: T0 + death * 1000
      });
      expect(incident.interruptedAttempts).toBe(death);
      expect(incident.attempt).toBe(1);
      if (death < 5) {
        expect(exhausted).toBe(false);
        // The dead isolate's entry was counted and dropped.
        expect(incident.attemptsInFlight?.map((a) => a.isolate)).toEqual([
          `isolate-${death}`
        ]);
      } else {
        expect(exhausted).toBe(true);
        expect(incident.status).toBe("exhausted");
        expect(incident.reason).toBe("interrupted_attempts_exceeded");
        // A sealed incident runs nothing more.
        expect(incident.attemptsInFlight).toBeUndefined();
      }
      existing = incident;
    }
  });

  it("counts a second report of the same death once", async () => {
    // Two recovery paths in one isolate (a legacy fiber row and a Task
    // reclaim) can both report the original turn's death.
    const first = await evaluate({ trigger: interrupted("isolate-b") });
    const again = await evaluate({
      trigger: interrupted("isolate-b", "attempt-2"),
      existing: first.incident,
      now: T0 + 1000
    });
    expect(first.incident.interruptedAttempts).toBe(1);
    expect(again.incident.interruptedAttempts).toBe(1);
  });

  it("does not count a replay when the previous attempt finished", async () => {
    // The record was cleared: the attempt finished, so its turn was not lost
    // to an isolate death.
    const first = await evaluate({ trigger: interrupted("isolate-a") });
    const { attemptsInFlight: _cleared, ...finished } = first.incident;
    const replay = await evaluate({
      trigger: interrupted("isolate-b"),
      existing: finished,
      now: T0 + 1000
    });
    expect(replay.incident.interruptedAttempts).toBe(1);
  });

  it("does not count a stall, and keeps the running attempt's record", async () => {
    const opened = await evaluate({ trigger: interrupted("isolate-a") });
    const stalled = await evaluate({
      trigger: { kind: "stalled" },
      existing: opened.incident,
      now: T0 + 1000
    });
    expect(stalled.incident.interruptedAttempts).toBe(1);
    expect(stalled.incident.attemptsInFlight).toEqual(
      opened.incident.attemptsInFlight
    );
    expect(stalled.exhausted).toBe(false);
  });

  it("seals the first interruption when maxInterruptedAttempts is 1", async () => {
    const { exhausted, incident } = await evaluate({
      trigger: interrupted("isolate-a"),
      config: config({ maxInterruptedAttempts: 1 })
    });
    expect(exhausted).toBe(true);
    expect(incident.reason).toBe("interrupted_attempts_exceeded");
  });

  it("never seals on interruptions when maxInterruptedAttempts is Infinity", async () => {
    const base = (await evaluate()).incident;
    const { exhausted } = await evaluate({
      trigger: interrupted("isolate-b"),
      config: config({ maxInterruptedAttempts: Number.POSITIVE_INFINITY }),
      existing: {
        ...base,
        interruptedAttempts: 1000,
        attemptsInFlight: [{ isolate: "isolate-a", token: "attempt-1" }]
      },
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS + 1
    });
    expect(exhausted).toBe(false);
  });

  it("carries transientRetries forward and seals once it reaches maxAttempts", async () => {
    const defaults = resolveChatRecoveryConfig(true);
    const base = (await evaluate()).incident;
    const existing = {
      ...base,
      attempt: 1,
      lastProgressAt: T0
    };

    const within = await evaluate({
      existing: { ...existing, transientRetries: defaults.maxAttempts - 1 },
      config: defaults,
      currentProgress: 5,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS - 1
    });
    expect(within.exhausted).toBe(false);
    expect(within.incident.transientRetries).toBe(defaults.maxAttempts - 1);

    const over = await evaluate({
      existing: { ...existing, transientRetries: defaults.maxAttempts },
      config: defaults,
      currentProgress: 6,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS - 1
    });
    expect(over.incident.attempt).toBe(1);
    expect(over.exhausted).toBe(true);
    expect(over.incident.reason).toBe("max_attempts_exceeded");
  });

  it("does not seal on interruptions while a client interaction is pending", async () => {
    // A parked HITL turn is budget-free, the interruption budget included.
    const base = (await evaluate()).incident;
    const { exhausted, incident } = await evaluate({
      trigger: interrupted("isolate-b"),
      existing: {
        ...base,
        attempt: 1,
        interruptedAttempts: DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS + 5,
        attemptsInFlight: [{ isolate: "isolate-a", token: "attempt-1" }],
        lastProgressAt: T0
      },
      awaitingClientInteraction: true,
      currentProgress: 5,
      now: T0 + CHAT_RECOVERY_ALARM_DEBOUNCE_MS - 1
    });
    expect(exhausted).toBe(false);
    expect(incident.interruptedAttempts).toBe(
      DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS + 6
    );
  });
});

describe("admitChatRecoveryAttempt / finishChatRecoveryAttempt (#2613)", () => {
  async function openedIncident() {
    return (
      await evaluateChatRecoveryIncident({
        identity,
        trigger: {
          kind: "interrupted",
          attempt: { isolate: "a", token: "t0" }
        },
        config: config(),
        existing: null,
        currentProgress: 0,
        awaitingClientInteraction: false,
        now: T0
      })
    ).incident;
  }

  it("counts an attempt left by another isolate and records the new one", async () => {
    const existing = await openedIncident();
    const { incident, exhausted } = admitChatRecoveryAttempt({
      existing,
      attempt: { isolate: "b", token: "t1" },
      config: config(),
      awaitingClientInteraction: false
    });
    expect(exhausted).toBe(false);
    expect(incident.interruptedAttempts).toBe(2);
    expect(incident.attemptsInFlight).toEqual([{ isolate: "b", token: "t1" }]);
  });

  it("does not count an attempt still running in this isolate", async () => {
    // The replay that scheduled this callback in the same isolate.
    const existing = await openedIncident();
    const { incident } = admitChatRecoveryAttempt({
      existing,
      attempt: { isolate: "a", token: "t1" },
      config: config(),
      awaitingClientInteraction: false
    });
    expect(incident.interruptedAttempts).toBe(1);
    expect(incident.attemptsInFlight).toEqual([
      { isolate: "a", token: "t0" },
      { isolate: "a", token: "t1" }
    ]);
  });

  it("seals instead of recording when the death spends the budget", async () => {
    const existing = {
      ...(await openedIncident()),
      interruptedAttempts: 4
    };
    const { incident, exhausted } = admitChatRecoveryAttempt({
      existing,
      attempt: { isolate: "b", token: "t1" },
      config: config(),
      awaitingClientInteraction: false
    });
    expect(exhausted).toBe(true);
    expect(incident.interruptedAttempts).toBe(5);
    expect(incident.attemptsInFlight).toBeUndefined();
  });

  it("does not seal a parked turn", async () => {
    const existing = {
      ...(await openedIncident()),
      interruptedAttempts: 4
    };
    const { exhausted } = admitChatRecoveryAttempt({
      existing,
      attempt: { isolate: "b", token: "t1" },
      config: config(),
      awaitingClientInteraction: true
    });
    expect(exhausted).toBe(false);
  });

  it("removes only the attempt that finished", async () => {
    const existing = await openedIncident();
    expect(
      finishChatRecoveryAttempt(existing, { isolate: "a", token: "t0" })
        ?.attemptsInFlight
    ).toBeUndefined();
    expect(
      finishChatRecoveryAttempt(existing, { isolate: "a", token: "unknown" })
    ).toBeNull();
  });

  it("tracks overlapping attempts apart, so a replay that dies after its callback finished still counts", () => {
    return openedIncident().then((opened) => {
      // The replay (t0) scheduled a callback that started in the same isolate.
      const withCallback = admitChatRecoveryAttempt({
        existing: opened,
        attempt: { isolate: "a", token: "t1" },
        config: config(),
        awaitingClientInteraction: false
      }).incident;
      // The callback finishes first; the replay is still running.
      const finished = finishChatRecoveryAttempt(withCallback, {
        isolate: "a",
        token: "t1"
      });
      expect(finished?.attemptsInFlight).toEqual([
        { isolate: "a", token: "t0" }
      ]);
      // Then the replay's isolate dies, and the next isolate counts it.
      const next = admitChatRecoveryAttempt({
        existing: finished ?? opened,
        attempt: { isolate: "b", token: "t2" },
        config: config(),
        awaitingClientInteraction: false
      });
      expect(next.incident.interruptedAttempts).toBe(2);
    });
  });

  it("counts one interruption for an isolate that died running two attempts", async () => {
    const existing = {
      ...(await openedIncident()),
      attemptsInFlight: [
        { isolate: "x", token: "t1" },
        { isolate: "x", token: "t2" }
      ]
    };
    const { incident } = admitChatRecoveryAttempt({
      existing,
      attempt: { isolate: "y", token: "t3" },
      config: config(),
      awaitingClientInteraction: false
    });
    expect(incident.interruptedAttempts).toBe(2);
    expect(incident.attemptsInFlight).toEqual([{ isolate: "y", token: "t3" }]);
  });
});
