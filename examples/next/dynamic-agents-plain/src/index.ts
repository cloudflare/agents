import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { DynamicAgents } from "agents/dynamic-agents";
import { Lifecycle, type LifecycleRouteEnvelope } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";

type Note = { id: number; text: string; created_at: string };

/**
 * A notebook: one dynamic agent per notebook, spawned and supervised by a
 * Workspace. It runs in its own isolate with its own SQLite database and
 * keeps its own WebSocket handlers; the sockets live on the workspace and
 * are bridged in.
 */
export class Notebook extends DurableObject<Env> {
  readonly children = new DynamicAgents();
  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection) => {
        connection.send(
          JSON.stringify({ type: "hello", notebook: this.children.name })
        );
      },
      onMessage: (connection, message) => {
        const text = String(message);
        if (text.startsWith("note:")) {
          const note = this.addNote(text.slice(5));
          // Every client of this notebook sees the new note.
          for (const peer of this.webSockets.getConnections()) {
            peer.send(JSON.stringify({ type: "note", note }));
          }
          return;
        }
        connection.send(JSON.stringify({ type: "error", message: "unknown" }));
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.children)
    .use(this.webSockets, { fallback: true });

  /** The routing aperture every dynamic agent host exposes. */
  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  onStart(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  /** Reached over `/sub/notebook/{name}/...` through the workspace. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/notes") {
      const { text } = (await request.json()) as { text: string };
      return Response.json({ note: this.addNote(text) }, { status: 201 });
    }
    return Response.json({
      notebook: this.children.name,
      workspace: this.children.parentPath[0]?.name ?? null,
      notes: this.listNotes()
    });
  }

  addNote(text: string): Note {
    return this.ctx.storage.sql
      .exec<Note>(
        "INSERT INTO notes (text, created_at) VALUES (?, ?) RETURNING id, text, created_at",
        text,
        new Date().toISOString()
      )
      .one();
  }

  listNotes(): Note[] {
    return [
      ...this.ctx.storage.sql.exec<Note>(
        "SELECT id, text, created_at FROM notes ORDER BY id"
      )
    ];
  }
}

/**
 * A workspace: a plain Durable Object that owns notebooks as dynamic agents.
 * `/agents/workspace/{workspace}/notebooks` manages them; anything under
 * `/agents/workspace/{workspace}/sub/notebook/{name}/...` — HTTP or
 * WebSocket — is forwarded to that notebook by the capability.
 */
export class Workspace extends DurableObject<Env> {
  readonly children = new DynamicAgents({
    // Gate every request bound for a notebook. Here: only notebooks this
    // workspace created may be reached, so URLs cannot conjure new ones.
    onBeforeChild: (_request, child) => {
      if (!this.children.has(Notebook, child.name)) {
        return new Response("No such notebook", { status: 404 });
      }
      return undefined;
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.children);

  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  async onRequest(request: Request): Promise<Response> {
    // The router delivers the full `/agents/workspace/{name}/...` path.
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    const at = segments.indexOf("notebooks");
    if (at === -1) {
      return Response.json({
        workspace: this.lifecycle.name,
        notebooks: this.children.list(Notebook).map((entry) => entry.name)
      });
    }
    const [name, action] = segments.slice(at + 1);
    if (!name) {
      return Response.json({
        notebooks: this.children.list(Notebook).map((entry) => entry.name)
      });
    }
    if (request.method === "POST" && action === "abort") {
      // Stops the notebook now; its notes survive for the next request.
      this.children.abort(Notebook, name, new Error("aborted by workspace"));
      return Response.json({ aborted: name });
    }
    if (request.method === "POST") {
      const notebook = await this.children.get(Notebook, name);
      return Response.json(
        { created: name, notes: await notebook.listNotes() },
        { status: 201 }
      );
    }
    if (request.method === "DELETE") {
      // Wipes the notebook's storage and closes nothing else: its clients
      // reconnect to a fresh, empty notebook if they try again.
      await this.children.delete(Notebook, name);
      return Response.json({ deleted: name });
    }
    return new Response("Method not allowed", { status: 405 });
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
