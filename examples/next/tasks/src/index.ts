import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Tasks, type TaskStep } from "agents/tasks";
import { getCurrentAgent, Lifecycle } from "agents/lifecycle";

type ReportInput = {
  topic: string;
  holdSeconds: number;
};

type ReportResult = {
  topic: string;
  summary: string;
};

type PublishedReport = {
  topic: string;
  summary: string;
  publishedAt: string;
  publishedBy: string | null;
};

/** A plain Durable Object with the Tasks capability installed. */
export class ReportObject extends DurableObject<Env> {
  /**
   * The constructor map is the definitions registry, like Scheduler
   * callbacks: it is rebuilt on every Durable Object wake, so in-flight runs
   * always resolve their persisted definition names.
   *
   * Every execution attempt replays a handler from the top: completed steps
   * return journaled results, the sleep consults its persisted deadline, and
   * a fresh instance resumes an interrupted run from the first unfinished
   * step.
   */
  readonly tasks = new Tasks({
    definitions: {
      "publish-report@v1": async (
        input: ReportInput,
        step: TaskStep
      ): Promise<ReportResult> => {
        await step.status("Drafting");

        const summary = await step.do(
          "draft",
          { retries: { limit: 4, delay: "2 seconds", backoff: "exponential" } },
          () => this.draftSummary(input.topic)
        );

        // No isolate stays resident during the hold: the run parks on a
        // durable deadline, and the shared Lifecycle alarm wakes a fresh
        // instance when it passes.
        await step.sleep("editorial-hold", input.holdSeconds * 1000);

        await step.status("Publishing");
        await step.do("publish", () => {
          const { agent } = getCurrentAgent<ReportObject>();
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO published_reports
               (topic, summary, published_at, published_by)
             VALUES (?, ?, ?, ?)`,
            input.topic,
            summary,
            new Date().toISOString(),
            agent?.lifecycle.name ?? null
          );
        });

        return { topic: input.topic, summary };
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.tasks);

  draftSummary(topic: string): string {
    return `${topic} in three lines: what it is, why it matters, and what to watch next.`;
  }

  onStart(): void {
    // Published reports live in the host's own table; the run bookkeeping
    // (cf_agents_task_runs, cf_agents_task_steps) is owned by the capability.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS published_reports (
        topic TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT
      )
    `);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/reports")) {
      const body = (await request.json()) as {
        topic?: string;
        holdSeconds?: number;
      };
      const topic = body.topic ?? "durable execution";
      // The receipt means the run and its wake-up deadline are durable, not
      // that the run has finished. Repeating the same idempotency key joins
      // the existing run (`accepted: false`) instead of starting a second.
      const receipt = await this.tasks.run(
        "publish-report@v1",
        { topic, holdSeconds: body.holdSeconds ?? 10 },
        { idempotencyKey: `report:${topic}` }
      );
      return Response.json(
        { receipt },
        { status: receipt.accepted ? 201 : 200 }
      );
    }

    if (request.method === "DELETE") {
      const runId = url.pathname.split("/").at(-1) ?? "";
      const cancelled = await this.tasks.cancel(runId, "cancelled via API");
      return Response.json({ cancelled }, { status: cancelled ? 200 : 404 });
    }

    if (request.method === "GET" && url.pathname.includes("/reports/")) {
      const runId = url.pathname.split("/").at(-1) ?? "";
      const run = await this.tasks.handle("publish-report@v1").get(runId);
      return run
        ? Response.json({ run })
        : Response.json({ error: "not found" }, { status: 404 });
    }

    return Response.json({
      name: this.lifecycle.name,
      runs: await this.tasks.list(),
      published: [
        ...this.ctx.storage.sql.exec<PublishedReport>(
          `SELECT topic, summary, published_at AS publishedAt,
                  published_by AS publishedBy
           FROM published_reports ORDER BY published_at DESC`
        )
      ]
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
