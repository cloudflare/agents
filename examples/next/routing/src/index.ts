import { DurableObject } from "cloudflare:workers";
import {
  Agent,
  callable,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import { Lifecycle } from "agents/lifecycle";
import { RoutedAgents } from "agents/routing";

/**
 * A hub that owns an open-ended set of independent Agents. `RoutedAgents`
 * keeps a durable catalog of public entry IDs mapped to opaque physical
 * names, and forwards `/notes/{id}/...` requests and WebSocket upgrades
 * under the hub's URL to the selected Agent.
 *
 * The hub is a plain Durable Object composed with Lifecycle. The targets
 * must be `Agent`s: the capability relies on Agent's condemnation protocol
 * to wipe a deleted entry's storage.
 */

type NoteMeta = { title: string };

type Note = { id: number; text: string; at: number };

/** One Durable Object per notebook, reached only through its hub. */
export class NoteAgent extends Agent<Env> {
  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
  }

  @callable()
  add(text: string): Note {
    const [note] = this.sql<Note>`
      INSERT INTO notes (text, at) VALUES (${text}, ${Date.now()})
      RETURNING id, text, at
    `;
    return note;
  }

  @callable()
  list(): Note[] {
    return this.sql<Note>`SELECT id, text, at FROM notes ORDER BY id ASC`;
  }

  @callable()
  count(): number {
    const [row] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM notes`;
    return row.n;
  }

  /**
   * HTTP surface. The path the target sees is the forwarded suffix:
   * `/agents/hub-object/{hub}/notes/{id}/notes` arrives here as `/notes`.
   */
  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/notes") {
      return Response.json({
        name: this.name,
        notes: this.count(),
        routes: ["/notes"]
      });
    }
    if (request.method === "POST") {
      let body: Partial<{ text: string }>;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      if (typeof body.text !== "string" || !body.text.trim()) {
        return new Response('Body must be { "text": string }', {
          status: 400
        });
      }
      return Response.json(this.add(body.text.trim()), { status: 201 });
    }
    return Response.json(this.list());
  }

  /**
   * A WebSocket upgraded through the hub's route is answered by this
   * Agent, which then owns the socket: frames never wake the hub.
   */
  override onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`echo:${String(message)}`);
  }
}

/**
 * The hub. Catalog operations touch only the hub's own SQLite; no target
 * wakes for create, list, or setMetadata. Deleting hides the entry, condemns
 * the target, then drops the row.
 */
export class HubObject extends DurableObject<Env> {
  readonly notes = new RoutedAgents<NoteAgent, NoteMeta>({
    namespace: this.env.NoteAgent,
    // Claims every `/notes/{id}/...` path under this hub before onRequest
    // runs, so the hub's own routes below must not reuse the segment.
    route: "notes"
  });

  readonly lifecycle = Lifecycle.install(this).use(this.notes);

  /**
   * Catalog surface under /agents/hub-object/{name}/catalog. Forwarded
   * paths under /notes/ never reach here: the capability answers them, and
   * an unknown or deleted entry ID is a 404 from the capability.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const at = segments.lastIndexOf("catalog");
    if (at === -1) {
      return Response.json({
        name: this.lifecycle.name,
        entries: (await this.notes.list()).length,
        routes: ["/catalog", "/catalog/{id}", "/notes/{id}/notes"]
      });
    }
    const id = segments[at + 1];

    if (!id) {
      switch (request.method) {
        case "GET":
          return Response.json(await this.notes.list());
        case "POST": {
          const body = await readMeta(request);
          if (!body) return badMeta();
          return Response.json(await this.notes.create({ metadata: body }), {
            status: 201
          });
        }
        default:
          return new Response("Method not allowed", { status: 405 });
      }
    }

    switch (request.method) {
      case "GET": {
        // get() resolves an active entry to an initialized, typed stub.
        // This is the one catalog read that does wake the target.
        const stub = await this.notes.get(id);
        if (!stub) return new Response("Not found", { status: 404 });
        const entry = (await this.notes.list()).find((e) => e.id === id);
        return Response.json({ entry, notes: await stub.count() });
      }
      case "PATCH": {
        const body = await readMeta(request);
        if (!body) return badMeta();
        const updated = await this.notes.setMetadata(id, body);
        return updated
          ? Response.json({ ok: true })
          : new Response("Not found", { status: 404 });
      }
      case "DELETE": {
        const deleted = await this.notes.delete(id);
        return deleted
          ? Response.json({ ok: true })
          : new Response("Not found", { status: 404 });
      }
      default:
        return new Response("Method not allowed", { status: 405 });
    }
  }
}

async function readMeta(request: Request): Promise<NoteMeta | null> {
  try {
    const body = (await request.json()) as Partial<NoteMeta>;
    return typeof body.title === "string" && body.title.trim()
      ? { title: body.title.trim() }
      : null;
  } catch {
    return null;
  }
}

function badMeta(): Response {
  return new Response('Body must be { "title": string }', { status: 400 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Routes both /agents/hub-object/{hub} and the forwarded
    // /agents/hub-object/{hub}/notes/{id}/... paths: RoutedAgents claims the
    // latter from inside the hub once the request reaches it.
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "Routing demo. Catalog: /agents/hub-object/<hub>/catalog. Targets: /agents/hub-object/<hub>/notes/<id>/notes",
        { status: 404 }
      )
    );
  }
} satisfies ExportedHandler<Env>;
