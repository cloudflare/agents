import {
  AgentDeliveryCoordinator,
  AgentDeliveryScheduler,
  AgentDispatcher,
  PermanentDispatchError,
  SubmissionStore,
  createSubmissionRouter,
  type AgentDeliveryAttempt,
  type AgentTurnReceiver,
  type AgentTurnRequest,
  type SubmissionReplay,
  type SubmissionStatus
} from "@cloudflare/channels";
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

/** How the fake agent responds to the next turn deliveries. */
export type FakeAgentMode =
  | "acknowledge"
  | "fail_transient"
  | "reject_permanent"
  | "hang"
  | "flaky";

export interface FakeAgentBehavior {
  mode: FakeAgentMode;
  /** In `flaky` mode: deliveries of a turn that fail before one succeeds. */
  failuresBeforeSuccess: number;
}

/** One logical turn as the fake agent has experienced it. */
export interface FakeAgentTurnRecord {
  turnId: string;
  submissionId: string;
  text: string;
  /** Physical deliveries received — more than 1 shows at-least-once retries. */
  deliveries: number;
  /** Whether the agent has durably accepted (acknowledged) the turn. */
  acknowledged: boolean;
  firstReceivedAt: string;
  lastReceivedAt: string;
}

/** Structured receipt result; error classes do not survive RPC boundaries. */
export type FakeAgentReceipt =
  | { kind: "acknowledged"; turnId: string }
  | { kind: "failed"; retryable: boolean; message: string };

const DEFAULT_BEHAVIOR: FakeAgentBehavior = {
  mode: "acknowledge",
  failuresBeforeSuccess: 2
};

/** How long the `hang` behavior holds a delivery — past the dispatch timeout. */
const HANG_MS = 30_000;

/**
 * A stand-in for a real agent, with one dial: how it responds to deliveries.
 *
 * It follows AGENT-DELIVERY-CONTRACT.md — it records every receipt keyed by
 * the stable turn ID, and once a turn is acknowledged it never re-executes it,
 * only re-acknowledges. That makes duplicate deliveries (crashes, timeouts,
 * lease recovery) visible and harmless.
 */
export class FakeAgent extends DurableObject<Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS fake_agent_turns (
      turn_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      text TEXT NOT NULL,
      deliveries INTEGER NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      first_received_at TEXT NOT NULL,
      last_received_at TEXT NOT NULL
    )`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS fake_agent_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      behavior_json TEXT NOT NULL
    )`);
  }

  async receiveTurn(request: AgentTurnRequest): Promise<FakeAgentReceipt> {
    const now = new Date().toISOString();
    const payload = request.submission.payload;
    const text =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? String(payload.text ?? JSON.stringify(payload))
        : String(payload);
    this.#sql.exec(
      `INSERT INTO fake_agent_turns (
        turn_id, submission_id, text, deliveries,
        first_received_at, last_received_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (turn_id) DO UPDATE SET
        deliveries = deliveries + 1,
        last_received_at = excluded.last_received_at`,
      request.turnId,
      request.submission.submissionId,
      text,
      now,
      now
    );

    const record = this.#getTurn(request.turnId);
    // The delivery contract: an already-acknowledged turn is never executed
    // again — the agent just re-acknowledges so Channels can stop retrying.
    if (record !== undefined && record.acknowledged) {
      return { kind: "acknowledged", turnId: request.turnId };
    }

    const behavior = this.#behavior();
    switch (behavior.mode) {
      case "acknowledge":
        return this.#acknowledge(request.turnId);
      case "fail_transient":
        return {
          kind: "failed",
          retryable: true,
          message: "Simulated transient outage: connection reset by agent"
        };
      case "reject_permanent":
        return {
          kind: "failed",
          retryable: false,
          message: "Simulated permanent rejection: agent refused this input"
        };
      case "hang": {
        // Hold the delivery well past the dispatch timeout, then acknowledge
        // anyway: the late result arrives after Channels already recorded a
        // timeout, so the *next* delivery of this turn dedupes instantly.
        await new Promise((resolve) => setTimeout(resolve, HANG_MS));
        return this.#acknowledge(request.turnId);
      }
      case "flaky": {
        const deliveries = record?.deliveries ?? 1;
        if (deliveries <= behavior.failuresBeforeSuccess) {
          return {
            kind: "failed",
            retryable: true,
            message: `Simulated flaky agent: failure ${deliveries} of ${behavior.failuresBeforeSuccess}`
          };
        }
        return this.#acknowledge(request.turnId);
      }
    }
  }

  async setBehavior(behavior: FakeAgentBehavior): Promise<FakeAgentBehavior> {
    this.#sql.exec(
      `INSERT INTO fake_agent_config (id, behavior_json) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET behavior_json = excluded.behavior_json`,
      JSON.stringify(behavior)
    );
    return behavior;
  }

  async snapshot(): Promise<{
    behavior: FakeAgentBehavior;
    turns: FakeAgentTurnRecord[];
  }> {
    const turns = this.#sql
      .exec(
        `SELECT turn_id, submission_id, text, deliveries, acknowledged,
                first_received_at, last_received_at
         FROM fake_agent_turns
         ORDER BY first_received_at DESC, turn_id DESC`
      )
      .toArray()
      .map((row) => this.#recordFromRow(row));
    return { behavior: this.#behavior(), turns };
  }

  async reset(): Promise<void> {
    this.#sql.exec(`DELETE FROM fake_agent_turns`);
    this.#sql.exec(`DELETE FROM fake_agent_config`);
  }

  #acknowledge(turnId: string): FakeAgentReceipt {
    this.#sql.exec(
      `UPDATE fake_agent_turns SET acknowledged = 1 WHERE turn_id = ?`,
      turnId
    );
    return { kind: "acknowledged", turnId };
  }

  #behavior(): FakeAgentBehavior {
    const [row] = this.#sql
      .exec<Record<string, SqlStorageValue> & { behavior_json: string }>(
        `SELECT behavior_json FROM fake_agent_config WHERE id = 1`
      )
      .toArray();
    return row === undefined
      ? DEFAULT_BEHAVIOR
      : (JSON.parse(row.behavior_json) as FakeAgentBehavior);
  }

  #getTurn(turnId: string): FakeAgentTurnRecord | undefined {
    const [row] = this.#sql
      .exec(
        `SELECT turn_id, submission_id, text, deliveries, acknowledged,
                first_received_at, last_received_at
         FROM fake_agent_turns WHERE turn_id = ?`,
        turnId
      )
      .toArray();
    return row === undefined ? undefined : this.#recordFromRow(row);
  }

  #recordFromRow(row: Record<string, SqlStorageValue>): FakeAgentTurnRecord {
    return {
      turnId: String(row.turn_id),
      submissionId: String(row.submission_id),
      text: String(row.text),
      deliveries: Number(row.deliveries),
      acknowledged: Number(row.acknowledged) === 1,
      firstReceivedAt: String(row.first_received_at),
      lastReceivedAt: String(row.last_received_at)
    };
  }
}

/** A submission status enriched with its full attempt and replay history. */
export interface InspectedSubmission extends SubmissionStatus {
  attempts: AgentDeliveryAttempt[];
  replays: SubmissionReplay[];
}

/** Demo-friendly policy: fast retries, a small budget, a short lease. */
const DEMO_POLICY = {
  baseRetryDelayMs: 3_000,
  maxRetryDelayMs: 30_000,
  maxAttemptsPerCycle: 5,
  maxCycleAgeMs: 60 * 60 * 1_000,
  leaseDurationMs: 15_000
};

const DEMO_DISPATCH_TIMEOUT_MS = 5_000;

/**
 * The durable channel gateway: accepts submissions, owns the submission state
 * machine, and drives at-least-once delivery to the resolved agent from its
 * Durable Object alarm.
 */
export class ChannelGateway extends DurableObject<Env> {
  #store!: SubmissionStore;
  #scheduler!: AgentDeliveryScheduler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#build();
  }

  #build(): void {
    this.#store = new SubmissionStore(this.ctx.storage, {
      policy: DEMO_POLICY
    });
    const dispatcher = new AgentDispatcher((agentTarget) =>
      this.#resolveTarget(agentTarget)
    );
    const coordinator = new AgentDeliveryCoordinator(this.#store, dispatcher, {
      dispatchTimeoutMs: DEMO_DISPATCH_TIMEOUT_MS
    });
    // ctx.storage doubles as the durable alarm scheduler, so retries survive
    // restarts and evictions without any in-memory timer.
    this.#scheduler = new AgentDeliveryScheduler(
      this.#store,
      coordinator,
      this.ctx.storage
    );
  }

  #resolveTarget(agentTarget: string): AgentTurnReceiver {
    const stub = this.env.FAKE_AGENT.getByName(agentTarget);
    return {
      receiveTurn: async (request) => {
        const receipt = await stub.receiveTurn(request);
        if (receipt.kind === "acknowledged") {
          return { turnId: receipt.turnId };
        }
        if (receipt.retryable) {
          throw new Error(receipt.message);
        }
        throw new PermanentDispatchError(receipt.message);
      }
    };
  }

  async accept(input: Parameters<SubmissionStore["accept"]>[0]) {
    const acceptance = this.#store.accept(input);
    // Acknowledge fast; delivery happens after the response is returned.
    this.ctx.waitUntil(this.#scheduler.deliverDue());
    return acceptance;
  }

  async getStatus(submissionId: string): Promise<SubmissionStatus | undefined> {
    return this.#store.getStatus(submissionId);
  }

  async inspect(): Promise<{
    submissions: InspectedSubmission[];
    nextWakeAt?: string;
  }> {
    const submissions = this.#store.listStatuses().map((status) => ({
      ...status,
      attempts: this.#store.listAgentDeliveryAttempts(status.submissionId),
      replays: this.#store.listReplays(status.submissionId)
    }));
    const nextWakeAt = this.#store.nextDeliveryEventAt();
    return { submissions, ...(nextWakeAt === undefined ? {} : { nextWakeAt }) };
  }

  async cancel(submissionId: string) {
    return this.#store.cancel(submissionId);
  }

  async replay(submissionId: string, requestedBy: string) {
    const result = this.#store.replay(submissionId, { requestedBy });
    if (result.outcome === "replayed") {
      this.ctx.waitUntil(this.#scheduler.deliverDue());
    }
    return result;
  }

  /** One manual delivery pass, for stepping through the machine in the UI. */
  async deliverNow(): Promise<AgentDeliveryAttempt[]> {
    return this.#scheduler.deliverDue();
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#build();
  }

  async alarm(): Promise<void> {
    await this.#scheduler.deliverDue();
  }
}

const GATEWAY_NAME = "demo-gateway";
export const FAKE_AGENT_TARGET = "support-agent";

const app = new Hono<{ Bindings: Env }>();

const gateway = (env: Env) => env.CHANNEL_GATEWAY.getByName(GATEWAY_NAME);
const fakeAgent = (env: Env) => env.FAKE_AGENT.getByName(FAKE_AGENT_TARGET);

// The real package boundary: POST /api/submissions accepts canonical
// submissions; GET /api/submissions/:id returns the status projection.
app.route(
  "/api/submissions",
  createSubmissionRouter<{ Bindings: Env }>({
    acceptor: (c) => ({ accept: (input) => gateway(c.env).accept(input) }),
    reader: (c) => ({ getStatus: (id) => gateway(c.env).getStatus(id) })
  })
);

app.get("/api/inspector", async (c) => c.json(await gateway(c.env).inspect()));

app.post("/api/submissions/:id/cancel", async (c) =>
  c.json(await gateway(c.env).cancel(c.req.param("id")))
);

app.post("/api/submissions/:id/replay", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    requestedBy?: string;
  };
  return c.json(
    await gateway(c.env).replay(
      c.req.param("id"),
      body.requestedBy ?? "playground-operator"
    )
  );
});

app.post("/api/deliver", async (c) =>
  c.json({ attempts: await gateway(c.env).deliverNow() })
);

app.get("/api/agent", async (c) => c.json(await fakeAgent(c.env).snapshot()));

app.post("/api/agent/behavior", async (c) => {
  const behavior = (await c.req.json()) as FakeAgentBehavior;
  return c.json(await fakeAgent(c.env).setBehavior(behavior));
});

app.post("/api/reset", async (c) => {
  await gateway(c.env).reset();
  await fakeAgent(c.env).reset();
  return c.json({ ok: true });
});

export default app;
