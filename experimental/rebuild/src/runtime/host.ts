/**
 * The runtime host — the substrate beneath AgentDefinition. Receives the
 * definition value and drives it: engine created, channels started, admission
 * consulted, harness driven, outboxes pumped, reconcilers armed.
 *
 * startAgent() is "the DO wakes": it performs the wake scan (re-drive
 * interrupted turns, arm reconcilers) exactly as a Durable Object waking from
 * eviction would. Killing a host (stop({abort:true})) and starting a new one
 * over the same database IS the crash-recovery scenario.
 */

import type {
  AdmissionDecision,
  AgentDefinition,
  Engine,
  Entry,
  EntryRef,
  Inbox,
  NewEntry,
  TurnId,
  TurnInfo,
  TurnMarkerPayload
} from "../contract.js";
import type { Clock, SqlDatabase } from "../substrate.js";
import { systemClock } from "../substrate.js";
import { createEngine } from "../engine/engine.js";
import {
  createToolRuntime,
  settlePendingFromEntry,
  type ApprovalRequestedPayload,
  type ApprovalVerdictPayload,
  type ToolSettlementPayload
} from "../tools/runtime.js";
import { asCorrelationId, asTurnId, uuid } from "../ids.js";

export interface StartAgentOptions {
  readonly db: SqlDatabase;
  readonly clock?: Clock;
}

export interface Agent {
  readonly engine: Engine;
  /** Resolve an approval request by tool call id. */
  approve(callId: string, verdict: "granted" | "rejected"): Promise<void>;
  /** Append an async tool settlement (a provider's inbound half, for tests). */
  settleTool(callId: string, output: unknown, isError?: boolean): Promise<void>;
  /** Resolves when no turn is active or queued and all pumps are idle. */
  waitUntilQuiescent(timeoutMs?: number): Promise<void>;
  /** Stop pumps. abort:true also aborts in-flight drives (simulates a crash). */
  stop(opts?: { abort?: boolean }): Promise<void>;
}

const num = (v: unknown): number => v as number;
const str = (v: unknown): string => v as string;

export function startAgent(
  definition: AgentDefinition,
  opts: StartAgentOptions
): Agent {
  const clock = opts.clock ?? systemClock();
  const db = opts.db;
  const { engine, internal } = createEngine(db, clock);

  const tools = createToolRuntime({
    providers: definition.tools.providers,
    ...(definition.tools.middleware !== undefined
      ? { middleware: definition.tools.middleware }
      : {}),
    engine
  });
  for (const [name, reconciler] of Object.entries(
    definition.reconcilers ?? {}
  )) {
    engine.ledger.reconciler(
      name as Parameters<typeof engine.ledger.reconciler>[0],
      reconciler
    );
  }

  const branch = engine.log.root;
  let stopped = false;
  const driveControllers = new Map<string, AbortController>();
  let inFlightDrives = 0;
  const admissionQueue: Entry[] = [];
  let admissionRunning = false;
  let outboxRunning = false;
  let outboxDirty = false;
  let cancelReconcileTimer: (() => void) | null = null;
  const timers = new Set<() => void>();

  // ---- turn bookkeeping (rb_turns) ----------------------------------------

  function turnRow(turnId: string) {
    const rows = db.exec("SELECT * FROM rb_turns WHERE turn_id = ?", turnId);
    return rows.length === 0 ? null : rows[0];
  }

  function rowToTurnInfo(row: Record<string, unknown>): TurnInfo {
    const status = str(row.status);
    return {
      turnId: asTurnId(str(row.turn_id)),
      branch,
      trigger: JSON.parse(str(row.trigger_json)) as EntryRef,
      // "queued" is runtime-internal; the closest contract status is parked
      // (suspended, not stepping). Contract finding: TurnStatus lacks queued.
      status: (status === "queued" ? "parked" : status) as TurnInfo["status"],
      attempt: num(row.attempt),
      startedAt: num(row.started_at)
    };
  }

  function activeOrParkedTurn(): TurnInfo | undefined {
    const rows = db.exec(
      "SELECT * FROM rb_turns WHERE branch = ? AND status IN ('active','parked') ORDER BY started_at ASC LIMIT 1",
      branch
    );
    return rows.length === 0 ? undefined : rowToTurnInfo(rows[0]);
  }

  function queuedTurns(): TurnInfo[] {
    return db
      .exec(
        "SELECT * FROM rb_turns WHERE branch = ? AND status = 'queued' ORDER BY queued_order ASC",
        branch
      )
      .map(rowToTurnInfo);
  }

  function insertTurn(trigger: EntryRef, status: "active" | "queued"): TurnId {
    const turnId = asTurnId(uuid());
    const order = num(
      db.exec("SELECT COALESCE(MAX(queued_order), 0) + 1 AS n FROM rb_turns")[0]
        .n
    );
    db.exec(
      `INSERT INTO rb_turns (turn_id, branch, trigger_json, status, attempt, started_at, queued_order)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      turnId,
      branch,
      JSON.stringify(trigger),
      status,
      clock.now(),
      order
    );
    return turnId;
  }

  /** Admission outcomes are log-visible (ADR 0005): tail clients can tell an
   * admitted message from an ignored one without host access. */
  async function markAdmitted(turnId: TurnId, action: string): Promise<void> {
    await engine.append(
      [
        {
          origin: { module: "runtime" },
          turn: turnId,
          payload: {
            kind: "turn/marker",
            v: 1,
            marker: "admitted",
            turnId,
            attempt: 1,
            detail: { action }
          } satisfies TurnMarkerPayload
        } as unknown as NewEntry
      ],
      { branch }
    );
  }

  function setTurnStatus(
    turnId: string,
    status: string,
    bumpAttempt = false
  ): void {
    db.exec(
      `UPDATE rb_turns SET status = ?, attempt = attempt + ? WHERE turn_id = ?`,
      status,
      bumpAttempt ? 1 : 0,
      turnId
    );
  }

  // ---- driving ------------------------------------------------------------

  function scheduleDrive(turnId: TurnId): void {
    if (stopped) return;
    queueMicrotask(() => void driveTurn(turnId));
  }

  async function driveTurn(turnId: TurnId): Promise<void> {
    if (stopped || driveControllers.has(turnId)) return;
    const row = turnRow(turnId);
    if (row === null || str(row.status) !== "active") return;
    const info: TurnInfo = { ...rowToTurnInfo(row), status: "active" };
    const controller = new AbortController();
    driveControllers.set(turnId, controller);
    inFlightDrives += 1;
    const pseudoStep = uuid();
    try {
      await definition.harness.drive({
        turn: info,
        view: engine.view(branch),
        commit: async (entries: readonly NewEntry[]) => {
          const stamped = entries.map((e) =>
            e.turn === undefined ? ({ ...e, turn: turnId } as NewEntry) : e
          );
          const result = await engine.append(stamped, { branch });
          if (result.outcome !== "committed") {
            throw new Error(`turn commit failed: ${result.outcome}`);
          }
          return result.refs;
        },
        write: (chunk) => internal.emitChunk(turnId, pseudoStep, chunk),
        putBlob: (data, meta) => engine.blobs.putBlob(data, meta),
        openClaims: (filter) => engine.ledger.openClaims(filter),
        tools: tools.forTurn(info, controller.signal),
        signal: controller.signal
      });
    } catch (error) {
      console.warn(`[rebuild] harness threw for turn ${turnId}:`, error);
    } finally {
      driveControllers.delete(turnId);
      inFlightDrives -= 1;
    }
    if (stopped) return; // crash simulation: leave the turn as the log shows it
    await settleTurnFromLog(turnId);
  }

  /** Read the marker the harness left and update bookkeeping accordingly. */
  async function settleTurnFromLog(turnId: TurnId): Promise<void> {
    const markers = await engine.view(branch).query({
      kinds: ["turn/marker"],
      turn: turnId,
      limit: 1
    });
    const marker = markers[0]?.payload as TurnMarkerPayload | undefined;
    const state = marker?.marker;
    if (state === "completed" || state === "failed") {
      setTurnStatus(turnId, state);
      promoteQueued();
      return;
    }
    if (state === "parked") {
      setTurnStatus(turnId, "parked");
      return;
    }
    // The harness returned without leaving the log quiescent — a harness bug.
    // The runtime owns the terminal banner in that case.
    await engine.append(
      [
        {
          origin: { module: "runtime" },
          turn: turnId,
          payload: {
            kind: "turn/marker",
            v: 1,
            marker: "failed",
            turnId,
            attempt: 0,
            detail: {
              reason: "fatal",
              message: "harness left no quiescent marker"
            }
          } satisfies TurnMarkerPayload
        } as unknown as NewEntry
      ],
      { branch }
    );
    setTurnStatus(turnId, "failed");
    promoteQueued();
  }

  function promoteQueued(): void {
    if (activeOrParkedTurn() !== undefined) return;
    const next = queuedTurns()[0];
    if (next === undefined) return;
    setTurnStatus(next.turnId, "active");
    scheduleDrive(next.turnId);
  }

  // ---- admission pump -----------------------------------------------------

  function pumpAdmission(): void {
    if (admissionRunning || stopped) return;
    admissionRunning = true;
    queueMicrotask(async () => {
      try {
        while (admissionQueue.length > 0 && !stopped) {
          const entry = admissionQueue.shift() as Entry;
          await admit(entry);
        }
      } finally {
        admissionRunning = false;
        if (admissionQueue.length > 0) pumpAdmission();
      }
    });
  }

  async function admit(entry: Entry): Promise<void> {
    // Pending async settles first: a correlated settlement entry closes its
    // claim, which in turn emits the effect/settled entry admission acts on.
    await settlePendingFromEntry(engine, entry);

    const kinds = definition.admission.triggers.kinds;
    if (kinds !== undefined && !kinds.includes(entry.payload.kind)) return;
    const active = activeOrParkedTurn();
    const decision: AdmissionDecision = definition.admission.decide({
      entry,
      ...(active !== undefined ? { active } : {}),
      queued: queuedTurns()
    });
    switch (decision.action) {
      case "start": {
        const started = active === undefined;
        const turnId = insertTurn(entry.ref, started ? "active" : "queued");
        await markAdmitted(turnId, started ? "start" : "queue");
        if (started) scheduleDrive(turnId);
        break;
      }
      case "resume": {
        const row = turnRow(decision.turn);
        if (row !== null && str(row.status) === "parked") {
          setTurnStatus(decision.turn, "active", true);
          scheduleDrive(decision.turn);
        }
        break;
      }
      case "queue": {
        await markAdmitted(insertTurn(entry.ref, "queued"), "queue");
        break;
      }
      case "merge": {
        // Log-first makes merge free: the queued turn assembles its context
        // from the log when it starts, so the merged entry is naturally seen.
        break;
      }
      case "preempt": {
        if (active !== undefined) {
          driveControllers.get(active.turnId)?.abort();
        }
        await markAdmitted(insertTurn(entry.ref, "queued"), "preempt");
        break;
      }
      case "ignore":
        break;
    }
  }

  // ---- outbox pump --------------------------------------------------------

  const outboxes = definition.channels
    .filter((c) => c.outbound !== undefined)
    .map((c) => ({
      channel: c,
      outbox: c.outbound as NonNullable<typeof c.outbound>,
      consumer: engine.consumers.consumer(
        (c.outbound as NonNullable<typeof c.outbound>).consumer,
        { filter: (c.outbound as NonNullable<typeof c.outbound>).filter }
      ),
      attempt: 1
    }));

  function pumpOutboxes(): void {
    if (stopped) return;
    if (outboxRunning) {
      outboxDirty = true;
      return;
    }
    outboxRunning = true;
    queueMicrotask(async () => {
      try {
        do {
          outboxDirty = false;
          for (const o of outboxes) {
            for (;;) {
              const batch = await o.consumer.pull(16);
              if (batch === null) break;
              const dedupeKey = `${o.outbox.consumer}:${batch.cursor}`;
              try {
                await o.outbox.deliver(batch.entries, {
                  dedupeKey,
                  attempt: o.attempt,
                  signal: new AbortController().signal
                });
                o.attempt = 1;
                await o.consumer.ack(batch.cursor);
              } catch (error) {
                if (o.outbox.contract === "at-most-once") {
                  await o.consumer.ack(batch.cursor); // acted once; never retry
                  o.attempt = 1;
                } else {
                  o.attempt += 1;
                  const delay = Math.min(50 * 2 ** o.attempt, 5_000);
                  const cancel = clock.schedule(delay, () => {
                    timers.delete(cancel);
                    pumpOutboxes();
                  });
                  timers.add(cancel);
                  console.warn(
                    `[rebuild] outbox ${o.channel.name} delivery failed:`,
                    error
                  );
                }
                break;
              }
            }
          }
        } while (outboxDirty && !stopped);
      } finally {
        outboxRunning = false;
      }
    });
  }

  // ---- reconciler pump ----------------------------------------------------

  function armReconciler(): void {
    if (stopped) return;
    cancelReconcileTimer?.();
    cancelReconcileTimer = null;
    void (async () => {
      const next = await internal.reconcilePass(clock.now());
      if (next === null || stopped) return;
      const delay = Math.max(next - clock.now(), 10);
      cancelReconcileTimer = clock.schedule(delay, () => armReconciler());
    })();
  }

  // ---- wiring -------------------------------------------------------------

  const unsubscribe = internal.onCommitted((entries) => {
    for (const entry of entries) admissionQueue.push(entry);
    pumpAdmission();
    pumpOutboxes();
    armReconciler();
  });

  const inbox: Inbox = {
    submit: (entries, submitOpts) =>
      engine.append(entries, {
        branch,
        ...(submitOpts?.idempotencyKey !== undefined
          ? { idempotencyKey: submitOpts.idempotencyKey }
          : {})
      })
  };
  for (const channel of definition.channels) {
    // Ephemeral half first (ADR 0005), so early drives stream to the surface.
    channel.live?.(engine.tail({ live: true }));
    void channel.start?.(inbox);
  }

  // Wake scan: re-drive turns that were mid-flight when the last host died,
  // promote queued work, re-arm liveness. This is what a DO alarm/wake does.
  for (const row of db.exec(
    "SELECT turn_id FROM rb_turns WHERE branch = ? AND status = 'active'",
    branch
  )) {
    scheduleDrive(asTurnId(str(row.turn_id)));
  }
  promoteQueued();
  pumpOutboxes();
  armReconciler();

  // ---- public surface -----------------------------------------------------

  return {
    engine,
    async approve(callId, verdict) {
      const correlation = asCorrelationId(`tool:${callId}`);
      const requests = await engine.view(branch).query({
        kinds: ["tools/approval-requested"],
        correlation,
        limit: 1
      });
      if (requests.length === 0)
        throw new Error(`no approval request for ${callId}`);
      const request = requests[0];
      const payload: ApprovalVerdictPayload = {
        kind: "tools/approval-verdict",
        v: 1,
        callId,
        verdict
      };
      void (request.payload as ApprovalRequestedPayload);
      const entry: Record<string, unknown> = {
        origin: { module: "channel", instance: "approval" },
        correlation,
        payload
      };
      if (request.turn !== undefined) entry.turn = request.turn;
      await engine.append([entry as unknown as NewEntry], {
        branch,
        idempotencyKey: `approval-verdict:${callId}`
      });
    },
    async settleTool(callId, output, isError) {
      const payload: ToolSettlementPayload = {
        kind: "tools/settlement",
        v: 1,
        output: output as ToolSettlementPayload["output"],
        ...(isError !== undefined ? { isError } : {})
      };
      await engine.append(
        [
          {
            origin: { module: "channel", instance: "tool-settlement" },
            correlation: asCorrelationId(`tool:${callId}`),
            payload
          } as unknown as NewEntry
        ],
        { branch }
      );
    },
    async waitUntilQuiescent(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const busy =
          admissionQueue.length > 0 ||
          admissionRunning ||
          inFlightDrives > 0 ||
          outboxRunning ||
          db.exec(
            "SELECT COUNT(*) AS n FROM rb_turns WHERE status IN ('active','queued')"
          )[0].n !== 0;
        if (!busy) return;
        if (Date.now() > deadline) {
          throw new Error("waitUntilQuiescent timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async stop(stopOpts) {
      stopped = true;
      unsubscribe();
      cancelReconcileTimer?.();
      for (const cancel of timers) cancel();
      if (stopOpts?.abort === true) {
        for (const controller of driveControllers.values()) controller.abort();
      }
      // Give aborted drives a beat to unwind.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
}
