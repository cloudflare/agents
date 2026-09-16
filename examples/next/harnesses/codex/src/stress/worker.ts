import { Workspace } from "@cloudflare/shell";
import { Harness } from "@cloudflare/agents-next-harness";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { CodexRuntime } from "../codex-runtime";
import type { CodexProtocol } from "../protocol";
import { StressModel, type StressScenario } from "./model";

type StressEnv = {
  STRESS: DurableObjectNamespace<StressCoder>;
  WORKSPACE: R2Bucket;
};

/** The session every stress run drives. */
const SESSION = "main";
/** Longest one synthetic operation may take before the run is abandoned. */
const RUN_TIMEOUT_MS = 120_000;

/** Result of one synthetic operation. */
export type StressRun = {
  readonly operationId: string;
  readonly status: string;
  readonly wallMs: number;
  readonly kernelMs: number;
  readonly transitions: number;
  readonly checkpointBytes: number;
  readonly events: number;
  readonly modelCalls: number;
  readonly error?: string;
};

/** Durable footprint of one object after its runs. */
export type StressStats = {
  readonly operations: number;
  readonly checkpointBytesTotal: number;
  readonly checkpointBytesMax: number;
  readonly streamChunks: number;
  readonly streamBytes: number;
  readonly sessionMessages: number;
  readonly sessionContinuationRows: number;
  readonly sessionBytes: number;
  readonly databaseBytes: number;
  readonly kernelMemoryBytes: number;
};

/** The codex composition with a synthetic model, driven over RPC. */
export class StressCoder extends DurableObject<StressEnv> {
  private readonly model = new StressModel();
  private readonly tasks = new Tasks();
  private readonly streams = new Streams();
  private readonly sessions = new Sessions();
  private readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex",
    // Files past the inline threshold spill to R2; SQLite rows cannot hold
    // them.
    r2: this.env.WORKSPACE,
    r2Prefix: this.ctx.id.toString()
  });
  private readonly codex = new CodexRuntime({
    sessions: this.sessions,
    workspace: this.workspace,
    model: this.model,
    compaction: false
  });
  private readonly harness = new Harness<CodexProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.codex
  });
  private readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.harness);

  /** Run one operation to settlement under the given scenario. */
  async run(scenario: StressScenario, promptBytes = 64): Promise<StressRun> {
    this.model.scenario = scenario;
    this.model.reset();
    const before = this.model.calls;
    const prompt = `stress ${"x".repeat(Math.max(0, promptBytes - 7))}`;
    const started = performance.now();
    const session = this.harness.session(SESSION);
    const receipt = await session.prompt(prompt);
    const result = await session.wait(receipt.operationId, {
      timeoutMs: RUN_TIMEOUT_MS
    });
    const kernel = this.codex.kernelSnapshot(receipt.operationId);
    return {
      operationId: receipt.operationId,
      status: result.status,
      wallMs: Math.round(performance.now() - started),
      kernelMs: Number((kernel?.kernelMs ?? 0).toFixed(2)),
      transitions: kernel?.transitions ?? 0,
      checkpointBytes: JSON.stringify(kernel?.checkpoint ?? null).length,
      events: await this.#countEvents(receipt.cursor),
      modelCalls: this.model.calls - before,
      ...(result.error === undefined ? {} : { error: result.error.message })
    };
  }

  /** The Tasks journal for the session's driver run, for diagnosis. */
  steps(operationId: string): unknown {
    const sql = this.ctx.storage.sql;
    // The harness drives one Tasks run per session, not one per operation.
    const runId = `harness:harness:${SESSION}`;
    return {
      run: sql
        .exec(
          "SELECT state, attempt, error_name FROM cf_agents_task_runs WHERE run_id = ?",
          runId
        )
        .toArray(),
      steps: sql
        .exec(
          "SELECT step_name, kind, state, attempt, error_name FROM cf_agents_task_steps WHERE run_id = ? AND step_name LIKE ?",
          runId,
          `${operationId}:%`
        )
        .toArray()
    };
  }

  /** Measure what the runs left behind in this object. */
  async stats(): Promise<StressStats> {
    const sql = this.ctx.storage.sql;
    const one = <T extends Record<string, number>>(query: string): T =>
      sql.exec<T>(query).one();
    const ops = one<{ n: number; total: number; max: number }>(
      "SELECT count(*) AS n, coalesce(sum(length(checkpoint)), 0) AS total, coalesce(max(length(checkpoint)), 0) AS max FROM cf_codex_operations"
    );
    const chunks = one<{ n: number; total: number }>(
      "SELECT count(*) AS n, coalesce(sum(length(chunk)), 0) AS total FROM cf_agents_stream_chunks"
    );
    const messages = one<{ n: number; total: number }>(
      "SELECT count(*) AS n, coalesce(sum(length(content)), 0) AS total FROM cf_agents_session_messages"
    );
    const continuations = one<{ n: number; total: number }>(
      "SELECT count(*) AS n, coalesce(sum(length(content)), 0) AS total FROM cf_agents_session_message_chunks"
    );
    return {
      operations: ops.n,
      checkpointBytesTotal: ops.total,
      checkpointBytesMax: ops.max,
      streamChunks: chunks.n,
      streamBytes: chunks.total,
      sessionMessages: messages.n,
      sessionContinuationRows: continuations.n,
      sessionBytes: messages.total + continuations.total,
      databaseBytes: sql.databaseSize,
      kernelMemoryBytes: await this.codex.kernelMemoryBytes()
    };
  }

  /** Durable frames this operation appended, replayed from its cursor. */
  async #countEvents(from: string): Promise<number> {
    const controller = new AbortController();
    let seen = 0;
    for await (const event of this.harness.session(SESSION).events({
      from,
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if (!("preview" in event)) seen += 1;
    }
    return seen;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export default {
  async fetch(request: Request, env: StressEnv): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("object") ?? "stress";
    const stub = env.STRESS.getByName(name);
    try {
      if (request.method === "POST" && url.pathname === "/run") {
        const body = (await request.json()) as {
          scenario: StressScenario;
          promptBytes?: number;
        };
        return json(await stub.run(body.scenario, body.promptBytes));
      }
      if (url.pathname === "/stats") return json(await stub.stats());
      if (url.pathname === "/steps") {
        return json(await stub.steps(url.searchParams.get("operation") ?? ""));
      }
      return json({ error: "use POST /run or GET /stats" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        500
      );
    }
  }
} satisfies ExportedHandler<StressEnv>;
