import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { getCurrentAgent, Lifecycle } from "agents/lifecycle";
import { Queue, type QueueItem } from "agents/queue";

type UploadPayload = {
  fileName: string;
  bytes: number;
};

type ProcessedUpload = {
  itemId: string;
  fileName: string;
  bytes: number;
  processedAt: string;
  processedBy: string | null;
};

/** A plain Durable Object with the Queue capability installed. */
export class UploadObject extends DurableObject<Env> {
  readonly queue = new Queue({
    callbacks: {
      /**
       * Runs from the Lifecycle alarm loop, one item at a time in push
       * order — with this object available through `getCurrentAgent()`,
       * even when the alarm wakes a fresh instance. Registered callbacks
       * are typed where they are declared and where they are pushed.
       */
      processUpload: (
        payload: UploadPayload,
        item: QueueItem<UploadPayload>
      ) => {
        const { agent } = getCurrentAgent<UploadObject>();
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO processed_uploads
             (item_id, file_name, bytes, processed_at, processed_by)
           VALUES (?, ?, ?, ?, ?)`,
          item.id,
          payload.fileName,
          payload.bytes,
          new Date().toISOString(),
          agent?.lifecycle.name ?? null
        );
      }
    },
    // Callbacks that throw are retried with exponential backoff, then
    // dropped with a `queue:error` event once the attempts are exhausted.
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.queue);

  onStart(): void {
    // Processed uploads live in the host's own table, so they survive the
    // Durable Object leaving memory just like the pending queue items do.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_uploads (
        item_id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        processed_at TEXT NOT NULL,
        processed_by TEXT
      )
    `);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/uploads")) {
      const body = (await request.json()) as {
        fileName?: string;
        bytes?: number;
      };
      // `push()` types both the name and the payload against the registered
      // callbacks map. The item is durable before this call returns and runs
      // from the next alarm, so the request is answered without waiting.
      const item = await this.queue.push("processUpload", {
        fileName: body.fileName ?? "upload.bin",
        bytes: body.bytes ?? 0
      });
      return Response.json({ queued: item }, { status: 202 });
    }

    if (request.method === "DELETE") {
      const id = url.pathname.split("/").at(-1) ?? "";
      const cancelled = await this.queue.cancel(id);
      return Response.json({ cancelled }, { status: cancelled ? 200 : 404 });
    }

    return Response.json({
      name: this.lifecycle.name,
      pending: await this.queue.list(),
      processed: [
        ...this.ctx.storage.sql.exec<ProcessedUpload>(
          `SELECT item_id AS itemId, file_name AS fileName, bytes,
                  processed_at AS processedAt, processed_by AS processedBy
           FROM processed_uploads ORDER BY processed_at DESC`
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
