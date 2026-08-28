import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Streams, sseResponse } from "agents/streams";
import { Tasks, type TaskInterruption, type TaskStep } from "agents/tasks";

type GenerateInput = {
  streamId: string;
  total: number;
};

/**
 * A plain Durable Object composing the Streams and Tasks capabilities: a
 * durable task produces chunks into a durable stream, clients read the
 * stream over SSE independent of the producer's liveness, and an
 * interrupted producer is finalized from the stream's own durable cursor.
 */
export class GenerateObject extends DurableObject<Env> {
  readonly streams = new Streams();

  readonly tasks = new Tasks({
    definitions: {
      "generate@v1": {
        run: async (input: GenerateInput, step: TaskStep) => {
          return step.do("stream", async ({ checkpoint }) => {
            const stream = await this.streams.open(input.streamId);
            // Resuming producers start from the stream's own cursor, so a
            // replay never duplicates a chunk.
            for (let i = stream.cursor; i < input.total; i++) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              stream.append({ i, note: `chunk ${i} of ${input.total}` });
              checkpoint({ streamId: input.streamId, cursor: stream.cursor });
            }
            stream.close();
            return { streamId: input.streamId, cursor: input.total };
          });
        },
        recover: async (interruption: TaskInterruption<GenerateInput>) => {
          const checkpoint = (interruption.interruptedStep?.checkpoint ??
            null) as { streamId: string; cursor: number } | null;
          if (!checkpoint) return { action: "replay" as const };
          // The stream's durable status is the recovery evidence: finalize
          // with exactly the chunks that survived the interruption.
          const status = await this.streams.status(checkpoint.streamId);
          const writer = await this.streams.open(checkpoint.streamId);
          writer.close();
          return {
            action: "complete" as const,
            result: {
              streamId: checkpoint.streamId,
              cursor: status?.cursor ?? 0
            }
          };
        }
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.tasks);

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/generate")) {
      const body = (await request.json()) as {
        id?: string;
        total?: number;
      };
      const streamId = body.id ?? "demo";
      const receipt = await this.tasks.run(
        "generate@v1",
        { streamId, total: body.total ?? 10 },
        { idempotencyKey: `generate:${streamId}` }
      );
      return Response.json(
        { receipt },
        { status: receipt.accepted ? 201 : 200 }
      );
    }

    const streamMatch = url.pathname.match(/\/streams\/([^/]+)$/);
    if (request.method === "GET" && streamMatch) {
      const streamId = decodeURIComponent(streamMatch[1]);
      // Serve the durable stream over SSE: replay, `up-to-date`, live tail,
      // then `done`/`error`. Each chunk's seq rides the SSE `id:` field, so
      // a reconnecting EventSource resumes via Last-Event-ID automatically;
      // the request's signal aborts the tail when the client disconnects.
      return sseResponse(this.streams, streamId, { request });
    }

    return Response.json({
      name: this.lifecycle.name,
      runs: await this.tasks.list(),
      streams: await this.streams.list()
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
