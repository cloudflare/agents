import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
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
      const from = Number(url.searchParams.get("from") ?? "0");
      if ((await this.streams.status(streamId)) === null) {
        return new Response("Stream not found", { status: 404 });
      }

      // Serve the durable stream over SSE: replay from the requested
      // cursor, then tail live appends until the producer settles. The
      // request's own signal aborts a tail when the client disconnects.
      const streams = this.streams;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of streams.read(streamId, {
              from,
              signal: request.signal
            })) {
              controller.enqueue(
                encoder.encode(
                  `id: ${chunk.seq}\ndata: ${JSON.stringify(chunk.chunk)}\n\n`
                )
              );
            }
            const status = await streams.status(streamId);
            controller.enqueue(
              encoder.encode(`event: end\ndata: ${status?.state}\n\n`)
            );
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache"
        }
      });
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
