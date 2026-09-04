import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { CodexHarness } from "../codex-harness";
import { StressModel, type StressScenario } from "./model";

type StressEnv = {
  STRESS: DurableObjectNamespace<StressCoder>;
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
  readonly events: number;
  readonly eventBytesTotal: number;
  readonly streamChunks: number;
  readonly databaseBytes: number;
  readonly kernelMemoryBytes: number;
};

/** The codex composition with a synthetic model, driven over RPC. */
export class StressCoder extends DurableObject<StressEnv> {
  private readonly model = new StressModel();
  private readonly tasks = new Tasks();
  private readonly streams = new Streams();
  private readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex"
  });
  private readonly codex = new CodexHarness({
    tasks: this.tasks,
    streams: this.streams,
    workspace: this.workspace,
    model: this.model
  });
  private readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.codex);

  /** Run one operation to settlement under the given scenario. */
  async run(scenario: StressScenario, promptBytes = 64): Promise<StressRun> {
    this.model.scenario = scenario;
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

  /** Measure what the runs left behind in this object. */
  async stats(): Promise<StressStats> {
    const sql = this.ctx.storage.sql;
    const one = <T extends Record<string, number>>(query: string): T =>
      sql.exec<T>(query).one();
    const ops = one<{ n: number; total: number; max: number }>(
      "SELECT count(*) AS n, coalesce(sum(length(checkpoint)), 0) AS total, coalesce(max(length(checkpoint)), 0) AS max FROM cf_codex_operations"
    );
    const events = one<{ n: number; total: number }>(
      "SELECT count(*) AS n, coalesce(sum(length(event)), 0) AS total FROM cf_codex_events"
    );
    const chunks = one<{ n: number }>(
      "SELECT count(*) AS n FROM cf_agents_stream_chunks"
    );
    return {
      operations: ops.n,
      checkpointBytesTotal: ops.total,
      checkpointBytesMax: ops.max,
      events: events.n,
      eventBytesTotal: events.total,
      streamChunks: chunks.n,
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
      return json({ error: "use POST /run or GET /stats" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        500
      );
    }
  }
} satisfies ExportedHandler<StressEnv>;
