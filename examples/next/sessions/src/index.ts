import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import {
  Sessions,
  attachmentResponse,
  type ReconstructMode,
  type SessionMessage
} from "agents/sessions";

function parseMessage(value: unknown): SessionMessage | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;
  if (!("role" in value) || typeof value.role !== "string") return null;
  if (!("parts" in value) || !Array.isArray(value.parts)) return null;
  if (
    !value.parts.every(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        typeof part.type === "string"
    )
  ) {
    return null;
  }
  // SAFETY: The checks above establish the structural SessionMessage fields.
  // Part-specific fields remain unknown to Sessions and round-trip as JSON.
  return value as SessionMessage;
}

function historyResponse(
  history: AsyncGenerator<SessionMessage, void, undefined>
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await history.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await history.return();
      }
    }),
    { headers: { "content-type": "application/x-ndjson" } }
  );
}

/** A plain Durable Object with durable conversation history and attachments. */
export class SessionObject extends DurableObject<Env> {
  readonly sessions = new Sessions({
    attachments: {
      r2: this.env.ATTACHMENTS,
      r2ThresholdBytes: 1_500_000
    },
    searchIndexing: true
  });

  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly session = this.sessions.session();

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const message = parseMessage(await request.json());
      if (!message)
        return new Response("Invalid SessionMessage", { status: 400 });
      const parent = url.searchParams.get("parent");
      const result = await this.session.appendMessage(message, {
        parentId: parent === null ? undefined : parent || null,
        source: "client"
      });
      return Response.json(result, { status: result.inserted ? 201 : 200 });
    }

    if (request.method === "GET" && url.pathname.endsWith("/history")) {
      const reconstruct: ReconstructMode =
        url.searchParams.get("attachments") === "pointer"
          ? "pointer"
          : "inline";
      return historyResponse(
        this.session.history({ reconstruct, signal: request.signal })
      );
    }

    const branches = url.pathname.match(/\/branches\/([^/]+)$/);
    if (request.method === "GET" && branches) {
      return Response.json(
        await this.session.getBranches(decodeURIComponent(branches[1]))
      );
    }

    const attachment = url.pathname.match(/\/attachments\/([0-9a-f]{64})$/);
    if (request.method === "GET" && attachment) {
      return attachmentResponse(this.sessions, attachment[1]);
    }

    if (request.method === "POST" && url.pathname.endsWith("/compactions")) {
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("summary" in body) ||
        typeof body.summary !== "string" ||
        !("fromMessageId" in body) ||
        typeof body.fromMessageId !== "string" ||
        !("toMessageId" in body) ||
        typeof body.toMessageId !== "string"
      ) {
        return new Response("Invalid compaction", { status: 400 });
      }
      return Response.json(
        await this.session.addCompaction(
          body.summary,
          body.fromMessageId,
          body.toMessageId
        ),
        { status: 201 }
      );
    }

    if (request.method === "DELETE" && url.pathname.endsWith("/messages")) {
      await this.session.clearMessages();
      return new Response(null, { status: 204 });
    }

    return Response.json({
      name: this.lifecycle.name,
      sessions: await this.sessions.listSessions(),
      stats: await this.session.stats()
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
