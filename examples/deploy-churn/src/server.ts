/**
 * Deploy-churn recovery harness — Worker entry + agent.
 *
 * The wrangler-dev kill/restart e2e tests cover one class of eviction (process
 * dies, same code restarts against the same persisted state). A *real* deploy
 * is different: `wrangler deploy` ships a NEW script version, and an in-flight
 * Durable Object running the OLD version is reset with
 * "Durable Object reset because its code was updated". Storage calls on that
 * stale isolate keep throwing for the rest of the invocation; fresh code only
 * loads on the next execution (a new requestId).
 *
 * This is a `Think` agent (matching the runtime the customer report describes:
 * `continueLastTurn`, durable submissions, the `_chatRecoveryContinue` alarm).
 * It is intentionally LLM-free and deterministic: `getModel()` returns a mock
 * model that streams one chunk per second for a configurable duration, so a
 * deploy reliably lands mid-turn. `chatRecovery` is enabled, so an interrupted
 * turn is wrapped in a durable fiber and continued via the alarm-scheduled
 * `_chatRecoveryContinue`.
 *
 * Error visibility is the point of this file. We capture BOTH error hooks:
 *   - `onChatError(error, ctx)` — per-turn failures, tagged with a `stage`
 *     ("turn" | "stream" | "recovery" | ...). `stage: "recovery"` is exactly
 *     the case the report cares about: a recovery continuation that failed on a
 *     stale, just-superseded isolate.
 *   - `onError(error)` — agent-level failures (scheduled callback dispatch,
 *     scheduled task execution) that never reach a chat turn.
 * Both are logged as one structured JSON line (`"kind":"deploy-churn"`) so they
 * are queryable via `wrangler tail` / the Workers Observability MCP server, and
 * persisted to storage so the orchestrator can read them over RPC.
 */
import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ChatResponseResult,
  ChunkContext
} from "@cloudflare/think";
import { callable, routeAgentRequest } from "agents";
import type { LanguageModel, UIMessage } from "ai";

type Env = {
  DeployChurnAgent: DurableObjectNamespace<DeployChurnAgent>;
};

/** A finalized chat turn, recorded from `onChatResponse`. */
type TurnRecord = {
  at: number;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
  textLength: number;
};

/** A per-turn error, recorded from `onChatError`. */
type ChatErrorRecord = {
  at: number;
  requestId?: string;
  stage: string;
  messagesPersisted?: boolean;
  name: string;
  message: string;
};

/** An agent-level error, recorded from `onError`. */
type AgentErrorRecord = {
  at: number;
  name: string;
  message: string;
};

type RecoveryContextRecord = {
  at: number;
  incidentId: string;
  streamId: string;
  requestId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: "retry" | "continue";
  partialTextLength: number;
};

type ChatRecoveryIncidentRecord = {
  incidentId: string;
  requestId: string;
  recoveryKind: string;
  attempt: number;
  maxAttempts: number;
  status: string;
  firstSeenAt: number;
  lastAttemptAt: number;
  reason?: string;
};

const TURNS_KEY = "harness:turns";
const CHAT_ERRORS_KEY = "harness:chat-errors";
const AGENT_ERRORS_KEY = "harness:agent-errors";
const RECOVERY_CONTEXTS_KEY = "harness:recovery-contexts";
const EXHAUSTED_KEY = "harness:exhausted";
const CHAT_RECOVERY_INCIDENT_KEY_PREFIX = "cf:chat-recovery:incident:";

const DEFAULT_DURATION_SECONDS = 90;
const CHUNK_INTERVAL_MS = 1_000;
const MAX_RECORDS = 200;

function parseDurationSeconds(text: string): number {
  const match = text.match(/(\d{1,4})\s*(s|sec|secs|second|seconds)?\b/i);
  if (!match) return DEFAULT_DURATION_SECONDS;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DURATION_SECONDS;
  return Math.min(value, 600);
}

/**
 * Deterministic slow model: streams one chunk per second for `seconds`, so a
 * deploy reliably lands mid-turn. No LLM, no tokens, no flakiness.
 */
function createSlowMockModel(seconds: number): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "deploy-churn",
    modelId: "mock-slow",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          for (let i = 0; i < seconds; i++) {
            await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
            controller.enqueue({
              type: "text-delta",
              id: "t",
              delta: `[${i + 1}/${seconds}] `
            });
          }
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: seconds }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class DeployChurnAgent extends Think<Env> {
  // Wake quickly after eviction so alarm-driven recovery is observable.
  static options = { keepAliveIntervalMs: 5_000 };

  // In-memory guard: CREATE TABLE runs once per isolate.
  private _tableReady = false;

  override chatRecovery: ChatRecoveryConfig = {
    maxAttempts: 6,
    onExhausted: (ctx: ChatRecoveryExhaustedContext) => {
      this.log("recovery:exhausted", {
        incidentId: ctx.incidentId,
        requestId: ctx.requestId,
        attempt: ctx.attempt,
        maxAttempts: ctx.maxAttempts,
        recoveryKind: ctx.recoveryKind,
        reason: ctx.reason
      });
      void this.ctx.storage.put(EXHAUSTED_KEY, {
        at: Date.now(),
        incidentId: ctx.incidentId,
        requestId: ctx.requestId,
        attempt: ctx.attempt,
        maxAttempts: ctx.maxAttempts,
        reason: ctx.reason
      });
    }
  };

  override getModel(): LanguageModel {
    const lastUser = [...this.messages]
      .reverse()
      .find((m: UIMessage) => m.role === "user");
    const text = lastUser
      ? lastUser.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ")
      : "";
    return createSlowMockModel(parseDurationSeconds(text));
  }

  override getSystemPrompt(): string {
    return "Deploy-churn harness agent. Streams a deterministic slow response so a deploy can interrupt it.";
  }

  /** Single structured log line per event — queryable via tail / observability. */
  private log(event: string, data: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        kind: "deploy-churn",
        event,
        agent: this.name,
        ts: Date.now(),
        iso: new Date().toISOString(),
        ...data
      })
    );
  }

  private async append<T>(key: string, entry: T): Promise<void> {
    const list = (await this.ctx.storage.get<T[]>(key)) ?? [];
    list.push(entry);
    if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
    await this.ctx.storage.put(key, list);
  }

  // ── Turn lifecycle ────────────────────────────────────────────────────────

  /**
   * Durable SQL write on every streamed chunk. This is the load-bearing detail
   * for the report's failure mode: the recovery continuation (`continueLastTurn`)
   * re-runs the turn, so these writes also fire during the recovery alarm. When
   * a deploy resets the isolate mid-stream, an in-flight SQL write throws
   * "Durable Object reset because its code was updated" — exactly the
   * `.alarm → .sql` stack from the report — which surfaces via `onChatError`
   * (stage "stream"/"recovery") instead of a clean skip.
   */
  override onChunk(ctx: ChunkContext): void {
    if (ctx.chunk.type !== "text-delta") return;
    if (!this._tableReady) {
      this
        .sql`CREATE TABLE IF NOT EXISTS harness_chunks (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, delta TEXT)`;
      this._tableReady = true;
    }
    this
      .sql`INSERT INTO harness_chunks (at, delta) VALUES (${Date.now()}, ${ctx.chunk.text})`;
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const textLength = result.message.parts
      .filter((p) => p.type === "text")
      .reduce((n, p) => n + (p as { text: string }).text.length, 0);
    await this.append<TurnRecord>(TURNS_KEY, {
      at: Date.now(),
      requestId: result.requestId,
      continuation: result.continuation,
      status: result.status,
      error: result.error,
      textLength
    });
    this.log("turn:response", {
      requestId: result.requestId,
      continuation: result.continuation,
      status: result.status,
      error: result.error
    });
  }

  // ── Error capture (the whole point) ─────────────────────────────────────────

  /** Per-turn errors, tagged with the failure stage (incl. "recovery"). */
  override onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    this.log("error:chat", {
      stage: ctx?.stage,
      requestId: ctx?.requestId,
      messagesPersisted: ctx?.messagesPersisted,
      name,
      message
    });
    void this.append<ChatErrorRecord>(CHAT_ERRORS_KEY, {
      at: Date.now(),
      requestId: ctx?.requestId,
      stage: ctx?.stage ?? "unknown",
      messagesPersisted: ctx?.messagesPersisted,
      name,
      message
    });
    // Propagate unchanged so default terminal handling still runs.
    return error;
  }

  /** Agent-level errors (scheduled callback dispatch, scheduled tasks). */
  override async onError(error: unknown): Promise<void> {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    this.log("error:agent", { name, message });
    await this.append<AgentErrorRecord>(AGENT_ERRORS_KEY, {
      at: Date.now(),
      name,
      message
    });
  }

  // ── Recovery ────────────────────────────────────────────────────────────────

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    await this.append<RecoveryContextRecord>(RECOVERY_CONTEXTS_KEY, {
      at: Date.now(),
      incidentId: ctx.incidentId,
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      partialTextLength: ctx.partialText.length
    });
    this.log("recovery:detected", {
      incidentId: ctx.incidentId,
      requestId: ctx.requestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      partialTextLength: ctx.partialText.length
    });
    // Defaults: persist the partial message and schedule a continuation.
    return {};
  }

  // ── Inspection RPCs (read by the orchestrator over WebSocket) ───────────────

  @callable()
  async getStatus(): Promise<{
    name: string;
    messageCount: number;
    assistantMessages: number;
    turns: TurnRecord[];
    chatErrors: ChatErrorRecord[];
    agentErrors: AgentErrorRecord[];
    recoveryContexts: RecoveryContextRecord[];
    incidents: ChatRecoveryIncidentRecord[];
    exhausted: unknown;
    hasFiberRows: boolean;
    chunkWrites: number;
  }> {
    const [turns, chatErrors, agentErrors, recoveryContexts, exhausted] =
      await Promise.all([
        this.ctx.storage.get<TurnRecord[]>(TURNS_KEY),
        this.ctx.storage.get<ChatErrorRecord[]>(CHAT_ERRORS_KEY),
        this.ctx.storage.get<AgentErrorRecord[]>(AGENT_ERRORS_KEY),
        this.ctx.storage.get<RecoveryContextRecord[]>(RECOVERY_CONTEXTS_KEY),
        this.ctx.storage.get(EXHAUSTED_KEY)
      ]);
    const assistantMsgs = this.messages.filter(
      (m: UIMessage) => m.role === "assistant"
    );
    return {
      name: this.name,
      messageCount: this.messages.length,
      assistantMessages: assistantMsgs.length,
      turns: turns ?? [],
      chatErrors: chatErrors ?? [],
      agentErrors: agentErrors ?? [],
      recoveryContexts: recoveryContexts ?? [],
      incidents: await this._listIncidents(),
      exhausted: exhausted ?? null,
      hasFiberRows: this._hasFiberRows(),
      chunkWrites: this._chunkWrites()
    };
  }

  @callable()
  async getErrors(): Promise<{
    chatErrors: ChatErrorRecord[];
    agentErrors: AgentErrorRecord[];
  }> {
    return {
      chatErrors:
        (await this.ctx.storage.get<ChatErrorRecord[]>(CHAT_ERRORS_KEY)) ?? [],
      agentErrors:
        (await this.ctx.storage.get<AgentErrorRecord[]>(AGENT_ERRORS_KEY)) ?? []
    };
  }

  @callable()
  hasFiberRows(): boolean {
    return this._hasFiberRows();
  }

  @callable()
  async reset(): Promise<{ ok: true }> {
    for (const key of [
      TURNS_KEY,
      CHAT_ERRORS_KEY,
      AGENT_ERRORS_KEY,
      RECOVERY_CONTEXTS_KEY,
      EXHAUSTED_KEY
    ]) {
      await this.ctx.storage.delete(key);
    }
    const incidents = await this._listIncidents();
    for (const incident of incidents) {
      await this.ctx.storage.delete(
        `${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${encodeURIComponent(incident.incidentId)}`
      );
    }
    this.log("harness:reset", { clearedIncidents: incidents.length });
    return { ok: true };
  }

  private _hasFiberRows(): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  private _chunkWrites(): number {
    try {
      const rows = this.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM harness_chunks
      `;
      return rows[0]?.count ?? 0;
    } catch {
      return 0;
    }
  }

  private async _listIncidents(): Promise<ChatRecoveryIncidentRecord[]> {
    const map = await this.ctx.storage.list<ChatRecoveryIncidentRecord>({
      prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
    });
    return [...map.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
