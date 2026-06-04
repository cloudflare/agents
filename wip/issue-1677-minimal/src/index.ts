import { DurableObject } from "cloudflare:workers";

/**
 * Child Durable Object — only ever reached as a *facet* of `Parent`. It just
 * needs to be `export`ed (so it shows up in `ctx.exports`); it needs no
 * top-level binding and no migration entry, since it's never an addressable DO.
 */
export class Child extends DurableObject<Env> {
  /**
   * On a facet, `this.ctx.getWebSockets()` returns the HOST (`Parent`) DO's
   * hibernatable WebSockets — but ONLY if this facet was freshly bootstrapped
   * while the parent already held them. A facet bootstrapped earlier (before
   * the socket existed) sees `[]` even after the socket opens, so reuse does
   * NOT reproduce.
   *
   * Reading `readyState` (a native getter) on such a host-owned socket from the
   * facet's I/O context throws:
   *
   *   "Cannot perform I/O on behalf of a different Durable Object. I/O objects
   *    ... created in the context of one Durable Object cannot be accessed from
   *    a different Durable Object." (I/O type: Native)
   *
   * `getWebSockets()` and `deserializeAttachment()` are fine; only `readyState`
   * trips the cross-DO check. `wrangler dev`/miniflare never reproduces — there
   * a facet's `getWebSockets()` returns []. Deploy to reproduce.
   */
  readHostSockets(): string {
    const sockets = this.ctx.getWebSockets();
    const readyStates = sockets.map((ws) => ws.readyState); // throws in prod
    return `count=${sockets.length} readyStates=${JSON.stringify(readyStates)}`;
  }
}

/**
 * Parent Durable Object — bound top-level. Accepts a hibernatable WebSocket and
 * keeps it open, then on `/spawn` bootstraps the `Child` facet (exactly like
 * the Agents SDK: `ctx.facets.get(key, () => ({ class, id }))`) and calls a
 * method on the returned facet stub.
 */
export class Parent extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("parent-ok", { status: 200 });
  }

  async spawnChild(childName: string): Promise<string> {
    const ctx = this.ctx as unknown as FacetCapableCtx;
    const parentNs = ctx.exports.Parent;
    const childClass = ctx.exports.Child;
    if (!parentNs?.idFromName || !childClass) {
      throw new Error("missing ctx.exports");
    }

    const child = ctx.facets.get(childName, () => ({
      class: childClass,
      id: parentNs.idFromName(childName)
    }));
    // Throws "Cannot perform I/O ... (Native)" in production iff this Parent
    // currently holds a live (hibernatable) WebSocket.
    return child.readHostSockets();
  }

  // Hibernation handlers (required once acceptWebSocket is used).
  async webSocketMessage(): Promise<void> {}
  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parentName = url.searchParams.get("parent") ?? "p1";
    const stub = env.Parent.get(env.Parent.idFromName(parentName));

    if (url.pathname === "/spawn") {
      // Fresh facet name each call so every /spawn is a fresh bootstrap.
      const childName = url.searchParams.get("name") ?? crypto.randomUUID();
      const result = await stub.spawnChild(childName);
      return Response.json({ ok: true, result });
    }

    // WebSocket upgrade (and anything else) goes through the parent's fetch.
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;

/**
 * Minimal narrowing of the facets runtime API (the same surface the Agents SDK
 * uses to create a child facet).
 */
interface FacetCapableCtx {
  facets: {
    get(
      name: string,
      getStartupOptions: () => { class: unknown; id: DurableObjectId }
    ): { readHostSockets(): string };
  };
  exports: Record<
    string,
    | (DurableObjectNamespace & { idFromName(name: string): DurableObjectId })
    | undefined
  >;
}
