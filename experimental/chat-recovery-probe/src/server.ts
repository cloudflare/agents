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
 * The recovery knobs are written into agent state by /probe/start and exposed
 * via `this.chatRecovery` as live, state-backed getters (assigned in the
 * constructor, NOT in onStart — see the constructor comment), so they survive
 * deploy churn and are current the moment fiber recovery evaluates budgets.
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import { jsonSchema, tool, type ToolSet } from "ai";
import type {
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext
} from "@cloudflare/think";
import { createSyntheticModel, type SyntheticConfig } from "./synthetic-model";

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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Bind the recovery config to PERSISTED STATE via live property getters,
    // assigned synchronously in the constructor.
    //
    // Why not set this in `onStart`? Chat-fiber recovery
    // (`_handleInternalFiberRecovery`) and its scheduled continuations resolve
    // the recovery budgets through `_resolveChatRecoveryConfig()` (which reads
    // the live values off `this.chatRecovery`) and can run BEFORE the subclass
    // `onStart` body executes. A config assigned in `onStart` is therefore read
    // as the BASE default (`maxAttempts: 10`, `maxRecoveryWork: Infinity`) at
    // the moment that matters, so a configured budget/attempt seal silently
    // never fires (observed: a primed `work_budget_exceeded` incident fell
    // through to `conversation_changed` because `maxRecoveryWork` read as
    // Infinity). Assigning here — and exposing each knob as a getter that reads
    // `this.state` lazily — keeps the config both EARLY (set in the ctor) and
    // CURRENT (re-read on every access, so per-scenario `setState` is picked up
    // without another deploy).
    const agent = this;
    this.chatRecovery = {
      get maxAttempts() {
        return agent.state?.recovery?.maxAttempts ?? 50;
      },
      get noProgressTimeoutMs() {
        return agent.state?.recovery?.noProgressTimeoutMs ?? 5 * 60 * 1000;
      },
      get maxRecoveryWork() {
        return (
          agent.state?.recovery?.maxRecoveryWork ?? Number.POSITIVE_INFINITY
        );
      },
      get terminalMessage() {
        return (
          agent.state?.recovery?.terminalMessage ??
          "Probe recovery exhausted (terminal)."
        );
      },
      get shouldKeepRecovering() {
        const abortAfterAttempt = agent.state?.recovery?.abortAfterAttempt;
        if (abortAfterAttempt === undefined) return undefined;
        return (ctx: ChatRecoveryProgressContext) => {
          agent._recordPredicate(ctx);
          return ctx.attempt < abortAfterAttempt;
        };
      },
      get onExhausted() {
        return (ctx: ChatRecoveryExhaustedContext) =>
          agent._recordExhausted(ctx);
      }
    };
  }

  async onStart() {
    this._ensureProbeTable();
  }

  getModel() {
    const synth = this.state?.synth ?? DEFAULT_SYNTH;
    return createSyntheticModel(synth, () => this._recordCompletion());
  }

  // SERVER tools used by the scoping scenarios. They are only ever invoked when
  // the synthetic model is in the matching mode, so registering them here is
  // inert for every other scenario.
  //  - `slow_server`   (a7): `execute` runs until interrupted. Evicted
  //    mid-execute it is a NON-client-resolvable orphan that must recover via
  //    transcript repair (NOT park, NOT seal).
  //  - `approve_action` (a8): `needsApproval` parks the turn at
  //    `approval-requested`, which recovery exempts like a client tool.
  getTools(): ToolSet {
    const questionSchema = jsonSchema<{ question?: string }>({
      type: "object",
      properties: { question: { type: "string" } }
    });
    return {
      slow_server: tool({
        description: "A slow server tool that runs until interrupted.",
        inputSchema: questionSchema,
        execute: async (_input, { abortSignal }) => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5 * 60 * 1000);
            abortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true }
            );
          });
          return "slow server tool finished";
        }
      }),
      approve_action: tool({
        description: "An action that requires human approval before running.",
        inputSchema: questionSchema,
        needsApproval: true,
        execute: async () => "approved action executed"
      })
    };
  }

  getSystemPrompt() {
    return "You are a deterministic synthetic ticker used for recovery testing.";
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

  /**
   * Set the synth mode + recovery knobs into state WITHOUT starting a turn.
   * The `hitl` scenario needs the synthetic model configured before the driver
   * opens a WebSocket and sends a real chat request with `clientTools` (the only
   * path that registers a CLIENT-resolvable tool — `submitMessages`/`chat()`
   * server-side do not). `getModel()` reads the persisted mode on every isolate
   * start, so it survives the deploy/abort churn that follows.
   */
  async configureProbe(config: {
    synth?: Partial<SyntheticConfig>;
    recovery?: RecoveryKnobs;
  }) {
    const synth: SyntheticConfig = { ...DEFAULT_SYNTH, ...config.synth };
    const recovery: RecoveryKnobs = config.recovery ?? {};
    this.setState({ synth, recovery });
    return { configured: true, synth, recovery };
  }

  /**
   * Prime the (single) open recovery incident so the NEXT boot-time detection
   * seals it deterministically via `work_budget_exceeded`, through the
   * RACE-FREE boot path. `_handleInternalFiberRecovery` decides exhaustion the
   * instant it re-detects the interrupted chat fiber — BEFORE scheduling any
   * continuation — so the seal cannot be lost to the `conversation_changed`
   * skip that makes the live content-emitting `runaway` budget race
   * nondeterministic.
   *
   * Mechanics: `workBaseline = 0` makes `work = progress - 0` exceed the small
   * configured `maxRecoveryWork`; `status` is reset to a non-terminal value so a
   * prior benign skip does not stop re-evaluation. `lastAttemptAt` is set to NOW
   * (not 0) — a backdated timestamp would trip the 1h stale-incident sweep at
   * the top of `_beginChatRecoveryIncident`, deleting the primed record so the
   * next boot opens a FRESH incident with `workBaseline = currentProgress` and
   * never seals. The budget seal is independent of the alarm-debounce window, so
   * a fresh timestamp is safe. The incident's id/key are left untouched so it
   * still matches the live turn.
   *
   * After the seal fires once, `_exhaustChatRecovery` consumes the fiber, so
   * subsequent deploys find NO interrupted fiber and cannot re-emit
   * `onExhausted` — which is exactly the "seal exactly once" invariant the
   * `rapid` scenario then hammers with real deploys.
   */
  async primeSeal() {
    const now = Date.now();
    const primed: { key: string; progress: number }[] = [];
    const list = await this.ctx.storage.list<Record<string, unknown>>({
      prefix: INCIDENT_PREFIX
    });
    for (const [key, incident] of list) {
      const next: Record<string, unknown> = {
        ...incident,
        status: "attempting",
        workBaseline: 0,
        lastAttemptAt: now
      };
      delete next.reason;
      await this.ctx.storage.put(key, next);
      primed.push({ key, progress: Number(incident.progress ?? 0) });
    }
    return { primed: primed.length, incidents: primed };
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

    // Surface the restored client-tool schemas so the HITL scenario can confirm
    // `ask_user` is recognized as CLIENT-resolvable after an eviction (the
    // precondition for the pending-interaction recovery exemption).
    let lastClientTools: unknown = null;
    try {
      const rows = this.sql<{ value: string }>`
        SELECT value FROM think_config WHERE key = 'lastClientTools'`;
      if (rows.length > 0) lastClientTools = JSON.parse(rows[0].value);
    } catch {
      lastClientTools = null;
    }

    // Compact transcript so the driver can confirm the HITL turn is parked (a
    // leaf assistant part at `input-available`) before churning, and that it
    // reached a settled answer after the client replays the tool result.
    const transcript = this.messages.map((m) => ({
      role: m.role,
      parts: m.parts.map((p) => {
        const r = p as Record<string, unknown>;
        return { type: r.type, state: r.state };
      })
    }));

    return {
      progress,
      recovering,
      completed,
      incidents,
      exhausted,
      predicate,
      submissions,
      transcript,
      lastClientTools,
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
          case "config": {
            const body = (await request.json().catch(() => ({}))) as Parameters<
              ProbeAgent["configureProbe"]
            >[0];
            return json(await agent.configureProbe(body));
          }
          case "inspect": {
            const id = url.searchParams.get("id");
            if (!id) return json({ error: "missing id" }, { status: 400 });
            return json(await agent.inspectSubmission(id));
          }
          case "prime-seal":
            return json(await agent.primeSeal());
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
