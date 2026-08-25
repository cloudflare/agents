import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Scheduler, type Schedule } from "agents/schedules";

type ReminderPayload = {
  message: string;
};

type DeliveredReminder = {
  scheduleId: string;
  message: string;
  deliveredAt: string;
  deliveredBy: string | null;
};

/** A plain Durable Object with the Scheduler capability installed. */
export class ReminderObject extends DurableObject<Env> {
  readonly scheduler = new Scheduler(this);
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  onStart(): void {
    // Delivered reminders live in the host's own table, so they survive the
    // Durable Object leaving memory just like the pending schedule rows do.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivered_reminders (
        schedule_id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        delivered_by TEXT
      )
    `);
  }

  /**
   * Scheduled callback. Runs with this object as `this` and available through
   * `getCurrentAgent()`, even when the alarm wakes a fresh instance.
   */
  deliverReminder(
    payload: ReminderPayload,
    schedule: Schedule<ReminderPayload>
  ): void {
    const { agent } = getCurrentAgent<ReminderObject>();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO delivered_reminders
         (schedule_id, message, delivered_at, delivered_by)
       VALUES (?, ?, ?, ?)`,
      schedule.id,
      payload.message,
      new Date().toISOString(),
      agent?.lifecycle.name ?? null
    );
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/reminders")) {
      const body = (await request.json()) as {
        message?: string;
        seconds?: number;
        cron?: string;
      };
      const message = body.message ?? "ping";
      // `set()` checks that "deliverReminder" exists on this object and types
      // the payload against its first parameter. A cron string and a delay in
      // seconds create the same kind of durable schedule row.
      const schedule = await this.scheduler.set(
        body.cron ?? body.seconds ?? 5,
        "deliverReminder",
        { message }
      );
      return Response.json({ created: schedule }, { status: 201 });
    }

    if (request.method === "DELETE") {
      const id = url.pathname.split("/").at(-1) ?? "";
      const cancelled = await this.scheduler.cancel(id);
      return Response.json({ cancelled }, { status: cancelled ? 200 : 404 });
    }

    return Response.json({
      name: this.lifecycle.name,
      pending: await this.scheduler.list(),
      delivered: [
        ...this.ctx.storage.sql.exec<DeliveredReminder>(
          `SELECT schedule_id AS scheduleId, message,
                  delivered_at AS deliveredAt, delivered_by AS deliveredBy
           FROM delivered_reminders ORDER BY delivered_at DESC`
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
