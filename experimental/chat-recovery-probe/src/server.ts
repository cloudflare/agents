/**
 * Chat-recovery probe — a headless Think agent for validating the durable
 * chat-recovery assumptions in #1672 against the real production runtime.
 *
 * The "model" is synthetic (see synthetic-model.ts): it streams deterministic
 * `tick N` content entirely inside the Durable Object, so a turn is only ever
 * interrupted by a real isolate reset (a `wrangler deploy`) or an explicit
 * `ctx.abort()`. That isolates exactly the variable #1672 is about — a turn
 * making forward progress that keeps getting interrupted — with no LLM cost or
 * nondeterminism.
 *
 * Control surface (all plain HTTP, routed to the agent stub — no WebSocket):
 *   POST /probe/start?session=S      body: { synth?, recovery?, prompt?, submissionId?, idempotencyKey? }
 *   GET  /probe/inspect?session=S&id=SUBMISSION_ID
 *   GET  /probe/debug?session=S
 *   POST /probe/interrupt?session=S  -> ctx.abort() (simulated eviction)
 *   POST /probe/reset?session=S
 *
 * The recovery knobs are written into agent state by /probe/start and rebuilt
 * into `this.chatRecovery` on every isolate start, so they survive deploy churn.
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import type {
  ChatRecoveryConfig,
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext
} from "@cloudflare/think";
import { createSyntheticModel, type SyntheticConfig } from "./synthetic-model";

type Env = {
  ProbeAgent: DurableObjectNamespace<ProbeAgent>;
};

type RecoveryKnobs = {
  maxAttempts?: number;
  noProgressTimeoutMs?: number;
  maxRecoveryWork?: number;
  /** shouldKeepRecovering returns false once attempt >= this (omit to disable). */
  abortAfterAttempt?: number;
  terminalMessage?: string;
};

type ProbeState = {
  synth: SyntheticConfig;
  recovery: RecoveryKnobs;
};

const DEFAULT_SYNTH: SyntheticConfig = {
  mode: "progress",
  targetSteps: 8,
  intervalMs: 2000
};

const INCIDENT_PREFIX = "cf:chat-recovery:incident:";
const PROGRESS_KEY = "cf:chat-recovery:progress";

export class ProbeAgent extends Think<Env, ProbeState> {
  // Replaced at runtime from persisted state (see `_applyRecoveryConfig`).
  chatRecovery: ChatRecoveryConfig = true;

  async onStart() {
    this._ensureProbeTable();
    this._applyRecoveryConfig();
  }

  getModel() {
    const synth = this.state?.synth ?? DEFAULT_SYNTH;
    return createSyntheticModel(synth, () => this._recordCompletion());
  }

  getSystemPrompt() {
    return "You are a deterministic synthetic ticker used for recovery testing.";
  }

  // ── Recovery config ─────────────────────────────────────────────

  private _applyRecoveryConfig() {
    const knobs = this.state?.recovery ?? {};
    this.chatRecovery = {
      maxAttempts: knobs.maxAttempts ?? 50,
      noProgressTimeoutMs: knobs.noProgressTimeoutMs ?? 5 * 60 * 1000,
      maxRecoveryWork: knobs.maxRecoveryWork ?? Number.POSITIVE_INFINITY,
      terminalMessage:
        knobs.terminalMessage ?? "Probe recovery exhausted (terminal).",
      shouldKeepRecovering:
        knobs.abortAfterAttempt === undefined
          ? undefined
          : (ctx: ChatRecoveryProgressContext) => {
              this._recordPredicate(ctx);
              return ctx.attempt < (knobs.abortAfterAttempt as number);
            },
      onExhausted: (ctx: ChatRecoveryExhaustedContext) =>
        this._recordExhausted(ctx)
    };
  }

  // ── Control methods (called from the Worker fetch via stub RPC) ──

  async startProbe(config: {
    synth?: Partial<SyntheticConfig>;
    recovery?: RecoveryKnobs;
    prompt?: string;
    submissionId?: string;
    idempotencyKey?: string;
  }) {
    const synth: SyntheticConfig = { ...DEFAULT_SYNTH, ...config.synth };
    const recovery: RecoveryKnobs = config.recovery ?? {};
    this.setState({ synth, recovery });
    this._applyRecoveryConfig();

    const submissionId = config.submissionId ?? crypto.randomUUID();
    const result = await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              text:
                config.prompt ??
                `Emit ${synth.targetSteps} ticks (${synth.mode} mode).`
            }
          ]
        }
      ],
      {
        submissionId,
        idempotencyKey: config.idempotencyKey ?? submissionId,
        metadata: { synth, recovery }
      }
    );

    return {
      submissionId: result.submissionId,
      accepted: result.accepted,
      status: result.status,
      synth,
      recovery
    };
  }

  /**
   * Start a turn via the plain `chat()` path (no `submitMessages` layer), so the
   * only recovery in play is the chatRecovery fiber. Fire-and-forget: the turn
   * runs in the background sustained by keepAlive; the control RPC returns
   * immediately. Outcomes are observed via `/probe/debug` (incidents + the
   * `onExhausted` records), not via submissions.
   */
  async startProbeChat(config: {
    synth?: Partial<SyntheticConfig>;
    recovery?: RecoveryKnobs;
    prompt?: string;
  }) {
    const synth: SyntheticConfig = { ...DEFAULT_SYNTH, ...config.synth };
    const recovery: RecoveryKnobs = config.recovery ?? {};
    this.setState({ synth, recovery });
    this._applyRecoveryConfig();

    const text =
      config.prompt ?? `Emit ${synth.targetSteps} ticks (${synth.mode} mode).`;
    const noop = {
      onStart: () => {},
      onEvent: () => {},
      onDone: () => {},
      onError: () => {}
    };
    // Do not await — the turn runs for minutes; keepAlive + the recovery fiber
    // sustain it across restarts.
    this.ctx.waitUntil(
      this.chat(text, noop).catch((e) =>
        console.error("[probe] chat turn error", e)
      )
    );
    return { started: true, synth, recovery };
  }

  async debugState() {
    const incidents: unknown[] = [];
    const list = await this.ctx.storage.list<unknown>({
      prefix: INCIDENT_PREFIX
    });
    for (const value of list.values()) incidents.push(value);

    const progress = (await this.ctx.storage.get<number>(PROGRESS_KEY)) ?? 0;
    const recovering =
      (await this.ctx.storage.get<unknown>("cf:chat:recovering")) ?? null;
    const completed = this.sql<{
      at: number;
    }>`select * from cf_probe_completed order by at asc`;
    const exhausted = this.sql<{
      incident_id: string;
      reason: string;
      attempt: number;
      max_attempts: number;
      recovery_kind: string;
      partial_len: number;
      at: number;
    }>`select * from cf_probe_exhausted order by at asc`;
    const predicate = this.sql<{
      incident_id: string;
      attempt: number;
      work: number;
      age_ms: number;
      at: number;
    }>`select * from cf_probe_predicate order by at asc`;
    const submissions = await this.listSubmissions({ limit: 25 });

    return {
      progress,
      recovering,
      completed,
      incidents,
      exhausted,
      predicate,
      submissions,
      state: this.state ?? null
    };
  }

  async interrupt() {
    // ctx.abort() destroys this Durable Object instance immediately, simulating
    // an eviction. The in-flight turn's fiber is interrupted and recovery fires
    // on the next access. This RPC will not return cleanly — the caller treats
    // a rejected call as "interrupt fired".
    this.ctx.abort("probe-interrupt");
    return { aborted: true };
  }

  async reset() {
    const list = await this.ctx.storage.list({ prefix: INCIDENT_PREFIX });
    for (const key of list.keys()) await this.ctx.storage.delete(key);
    await this.ctx.storage.delete(PROGRESS_KEY);
    this._ensureProbeTable();
    this.sql`delete from cf_probe_exhausted`;
    this.sql`delete from cf_probe_predicate`;
    this.sql`delete from cf_probe_completed`;
    return { reset: true };
  }

  // ── Recording ───────────────────────────────────────────────────

  private _ensureProbeTable() {
    this.sql`create table if not exists cf_probe_exhausted (
      incident_id text,
      reason text,
      attempt integer,
      max_attempts integer,
      recovery_kind text,
      partial_len integer,
      at integer
    )`;
    this.sql`create table if not exists cf_probe_predicate (
      incident_id text,
      attempt integer,
      work integer,
      age_ms integer,
      at integer
    )`;
    this.sql`create table if not exists cf_probe_completed (
      at integer
    )`;
  }

  private _recordCompletion() {
    this._ensureProbeTable();
    this.sql`insert into cf_probe_completed (at) values (${Date.now()})`;
  }

  private _recordExhausted(ctx: ChatRecoveryExhaustedContext) {
    this._ensureProbeTable();
    this.sql`insert into cf_probe_exhausted
      (incident_id, reason, attempt, max_attempts, recovery_kind, partial_len, at)
      values (${ctx.incidentId}, ${ctx.reason}, ${ctx.attempt}, ${ctx.maxAttempts}, ${ctx.recoveryKind}, ${ctx.partialText.length}, ${Date.now()})`;
  }

  private _recordPredicate(ctx: ChatRecoveryProgressContext) {
    this._ensureProbeTable();
    this.sql`insert into cf_probe_predicate
      (incident_id, attempt, work, age_ms, at)
      values (${ctx.incidentId}, ${ctx.attempt}, ${ctx.work}, ${ctx.ageMs}, ${Date.now()})`;
  }
}

// ── Worker: route control endpoints to the agent stub ─────────────

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/probe/")) {
      const session = url.searchParams.get("session") ?? "default";
      const agent = await getAgentByName(env.ProbeAgent, session);
      const action = url.pathname.slice("/probe/".length);

      try {
        switch (action) {
          case "start": {
            const body = (await request.json().catch(() => ({}))) as Parameters<
              ProbeAgent["startProbe"]
            >[0];
            return json(await agent.startProbe(body));
          }
          case "start-chat": {
            const body = (await request.json().catch(() => ({}))) as Parameters<
              ProbeAgent["startProbeChat"]
            >[0];
            return json(await agent.startProbeChat(body));
          }
          case "inspect": {
            const id = url.searchParams.get("id");
            if (!id) return json({ error: "missing id" }, { status: 400 });
            return json(await agent.inspectSubmission(id));
          }
          case "debug":
            return json(await agent.debugState());
          case "interrupt": {
            // ctx.abort() rejects the in-flight RPC by design.
            await agent.interrupt().catch(() => {});
            return json({ aborted: true });
          }
          case "reset":
            return json(await agent.reset());
          default:
            return json({ error: `unknown action ${action}` }, { status: 404 });
        }
      } catch (error) {
        return json(
          {
            error: error instanceof Error ? error.message : String(error)
          },
          { status: 500 }
        );
      }
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
