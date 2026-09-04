import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { CodexHarness } from "../codex-harness";
import { StressModel, type StressScenario } from "./model";

type StressEnv = {
  STRESS: DurableObjectNamespace<StressCoder>;
  WORKSPACE: R2Bucket;
};

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
  private readonly codex = new CodexHarness({
    tasks: this.tasks,
    streams: this.streams,
    sessions: this.sessions,
    workspace: this.workspace,
    model: this.model,
    compaction: false
  });
  private readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.codex);

  /** Run one operation to settlement under the given scenario. */
  async run(scenario: StressScenario, promptBytes = 64): Promise<StressRun> {
    this.model.scenario = scenario;
    this.model.reset();
    const before = this.model.calls;
    const prompt = `stress ${"x".repeat(Math.max(0, promptBytes - 7))}`;
    const started = performance.now();
    const receipt = await this.codex.submit({ prompt });
    for (;;) {
      const snapshot = await this.codex.snapshot(receipt.operationId);
      if (
        snapshot &&
        (snapshot.status === "completed" || snapshot.status === "failed")
      ) {
        return {
          operationId: snapshot.operationId,
          status: snapshot.status,
          wallMs: Math.round(performance.now() - started),
          kernelMs: Number(snapshot.kernelMs.toFixed(2)),
          transitions: snapshot.transitions,
          checkpointBytes: JSON.stringify(snapshot.checkpoint).length,
          events: (await this.codex.events(snapshot.operationId)).length,
          modelCalls: this.model.calls - before,
          ...(snapshot.error === undefined ? {} : { error: snapshot.error })
        };
      }
      await scheduler.wait(20);
    }
  }

  /** The Tasks journal for one operation's driver run, for diagnosis. */
  steps(operationId: string): unknown {
    const sql = this.ctx.storage.sql;
    return {
      run: sql
        .exec(
          "SELECT state, attempt, error_name FROM cf_agents_task_runs WHERE run_id = ?",
          `codex:${operationId}`
        )
        .toArray(),
      steps: sql
        .exec(
          "SELECT step_name, kind, state, attempt, error_name FROM cf_agents_task_steps WHERE run_id = ?",
          `codex:${operationId}`
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
