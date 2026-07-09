// PROTOTYPE — react to this, do not build on it.
//
// The rethink composition model settled in wayfinder ticket 01 ("Composition
// model & registration flow"). Illustrative only: not wired into the package
// build, not expected to typecheck against real runtime types. The tracer
// bullet (ticket 04) is where this becomes real code in packages/rethink/src.
//
// Decisions captured:
//   1. Two boundary layers. Worker default export owns email/queue/cron +
//      routing and the ws-UPGRADE fetch. The DO instance owns the events the
//      runtime delivers directly: fetch (via stub), webSocketMessage/Close/
//      Error, alarm. The Worker is NOT in the per-frame ws path or the alarm
//      path, so those must be real methods on the DO instance.
//   2. Thin dispatch-only base class. The author extends `PrimitiveHost` — a
//      ~40-line base with ZERO domain behavior that installs the DO entrypoints
//      and fans them out to `this.#primitives`. This refines "no blessed base
//      class" to "no *god* base class"; a dispatch-only base is allowed. Bright
//      line: the moment domain behavior lands on PrimitiveHost, we've rebuilt
//      Think.
//   3. One special member. The only thing the author supplies is `build(ctx,
//      env)` returning the primitives array. No per-primitive properties, no
//      hand-written entrypoint forwarders.
//   4. Primitive interface = optional DO-shaped methods. Which inbound event
//      belongs to which primitive (multiplexing) is OUT — that is ticket 03.
//   5. Instance shape = (ctx, deps). ctx is the raw DO substrate; deps is an
//      explicit manifest of env bindings + sibling primitives, named by role,
//      so a primitive is reusable on a different DO. env is read ONLY in build().

// ─────────────────────────────────────────────────────────────────────────────
// (4) The narrow interface a primitive exposes.
// Every method optional, mirroring the DurableObject surface 1:1. `fetch`
// returns Response | undefined — undefined means "not mine, keep going".
// ─────────────────────────────────────────────────────────────────────────────

interface Primitive {
  fetch?(
    request: Request
  ): Promise<Response | undefined> | Response | undefined;
  webSocketMessage?(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): void | Promise<void>;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  alarm?(): void | Promise<void>;
  // Worker-originated, DO-processed events (email/queue/...) are NOT DO
  // entrypoints. How a primitive claims them, and how the two halves of a split
  // primitive bind together, is ticket 03. Sketched here as onEmail? only to
  // show the fan-out; the real vocabulary is 03's to design.
  onEmail?(msg: InboundEmail): void | Promise<void>;
}

interface InboundEmail {
  from: string;
  subject: string;
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) The thin, dispatch-only base class. Framework-provided. Zero domain
// behavior — pure fan-out to the author's primitives. This is the whole trick:
// it puts the runtime-delivered entrypoints (ws*, alarm) on the DO instance,
// where they MUST live, while keeping the author's class down to one member.
// ─────────────────────────────────────────────────────────────────────────────

declare abstract class DurableObject<Env = unknown> {
  constructor(ctx: DurableObjectState, env: Env);
  protected ctx: DurableObjectState;
  protected env: Env;
}

abstract class PrimitiveHost<Env = unknown> extends DurableObject<Env> {
  // The ONE thing the author supplies. Takes ctx/env as ARGS (never reads
  // subclass fields) to dodge the base-ctor-before-subclass-field-init footgun.
  protected abstract build(ctx: DurableObjectState, env: Env): Primitive[];

  #primitives?: Primitive[];
  private get primitives(): Primitive[] {
    // Lazy so it runs after super() completes; rebuilt fresh on hibernation wake.
    this.#primitives ??= this.build(this.ctx, this.env);
    return this.#primitives;
  }

  // Runtime-delivered DO entrypoints — installed once, here.
  async fetch(request: Request): Promise<Response> {
    for (const p of this.primitives) {
      const res = await p.fetch?.(request);
      if (res) return res;
    }
    return new Response("Not found", { status: 404 });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // TICKET 03: route to the ONE owning primitive instead of broadcasting.
    await Promise.all(
      this.primitives.map((p) => p.webSocketMessage?.(ws, message))
    );
  }
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    clean: boolean
  ) {
    await Promise.all(
      this.primitives.map((p) => p.webSocketClose?.(ws, code, reason, clean))
    );
  }
  async webSocketError(ws: WebSocket, error: unknown) {
    await Promise.all(
      this.primitives.map((p) => p.webSocketError?.(ws, error))
    );
  }
  async alarm() {
    // Broadcast: each primitive inspects its own due work. (Shared vs per-
    // primitive schedule storage is deferred to fog.)
    await Promise.all(this.primitives.map((p) => p.alarm?.()));
  }

  // Worker-originated event, forwarded in over RPC by the Worker builder. Fans
  // out through the primitives, as agreed. (Vocabulary for the general case is
  // ticket 03; email shown concretely here.)
  async deliverEmail(msg: InboundEmail) {
    await Promise.all(this.primitives.map((p) => p.onEmail?.(msg)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) Two example primitives. Constructor (ctx, deps); env never enters them.
// ─────────────────────────────────────────────────────────────────────────────

class WebSocketChannel implements Primitive {
  constructor(private ctx: DurableObjectState) {}

  fetch(request: Request): Response | undefined {
    if (new URL(request.url).pathname !== "/ws") return undefined; // not mine
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server /* ws routing/protocol deferred */);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(typeof message === "string" ? `echo:${message}` : "binary");
  }
}

interface EmailChannelDeps {
  // Named by ROLE, not by binding. build() maps env.* to this.
  send(to: string, subject: string, body: string): Promise<void>;
}

class EmailChannel implements Primitive {
  constructor(
    private ctx: DurableObjectState,
    private deps: EmailChannelDeps
  ) {}

  async onEmail(msg: InboundEmail): Promise<void> {
    await this.deps.send(
      msg.from,
      `re: ${msg.subject}`,
      `got ${msg.body.length}b`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (2)+(3)+(5) The author's DO: one member. Extends the thin base, implements
// build(). No entrypoint forwarders, no per-primitive properties.
// ─────────────────────────────────────────────────────────────────────────────

interface Env {
  EMAIL: { send(to: string, subject: string, body: string): Promise<void> };
}

class MyAgentDO extends PrimitiveHost<Env> {
  protected build(ctx: DurableObjectState, env: Env): Primitive[] {
    // Composition root: env.* read ONLY here, adapted to role-named deps.
    return [
      new WebSocketChannel(ctx),
      new EmailChannel(ctx, {
        send: (to, subject, body) => env.EMAIL.send(to, subject, body)
      })
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) The Worker builder: a GENERIC forwarder, not per-primitive registrations.
//
// A primitive has NO Worker half in the common case. The Worker only needs:
//   - a generic forwarder per entrypoint type (framework-provided) that calls a
//     conventional PrimitiveHost method,
//   - addressing: the one app-specific bit — given an event, which DO instance
//     NAME? (can't be per-primitive: one event resolves to one instance BEFORE
//     any primitive is in scope, and all primitives on it share that instance),
//   - a fallthrough policy to the author's own handler.
//
// The DO-side chain already owns "which primitive", so the Worker never knows
// about primitives at all. It never touches ws-frames or alarms — the runtime
// delivers those straight to the DO.
// ─────────────────────────────────────────────────────────────────────────────

// stand-ins for runtime types
type ExecutionContext = unknown;
type ForwardableEmailMessage = { from: string; to: string; subject?: string };
type DONamespace = { getByName(name: string): MyAgentDO };
type ExportedHandler = {
  fetch(r: Request, e: Env, c: ExecutionContext): Promise<Response>;
  email?(
    m: ForwardableEmailMessage,
    e: Env,
    c: ExecutionContext
  ): Promise<void>;
};

interface WorkerConfig {
  binding(env: Env): DONamespace;
  // Addressing is per-entrypoint (a URL and an email address resolve
  // differently). Returns the DO instance name, or undefined for "not ours".
  addressFetch?(request: Request): string | undefined;
  addressEmail?(message: ForwardableEmailMessage): string | undefined;
  // Does the DO chain get first crack at fetch? Default true; a 404 from the DO
  // falls through to the author's handler.
  fetchFirst?: boolean;
}

// The framework wraps ForwardableEmailMessage (streams + forward()/reply()
// methods don't survive plain RPC) in an RpcTarget, generically — exactly what
// agents' routeAgentEmail does today. Stand-in here.
declare function bridgeEmail(m: ForwardableEmailMessage): InboundEmail;

function defineWorker(
  config: WorkerConfig,
  userHandler: Partial<ExportedHandler> = {}
): ExportedHandler {
  const forwardFetch = async (request: Request, env: Env) => {
    const name = config.addressFetch?.(request);
    if (!name) return undefined; // can't address → not ours
    const res = await config.binding(env).getByName(name).fetch(request);
    return res.status === 404 ? undefined : res; // DO chain declined → fall through
  };

  return {
    async fetch(request, env, ctx) {
      if (config.fetchFirst ?? true) {
        const res = await forwardFetch(request, env);
        if (res) return res;
        if (userHandler.fetch) return userHandler.fetch(request, env, ctx);
      } else {
        const res = await userHandler.fetch?.(request, env, ctx);
        if (res && res.status !== 404) return res;
        const forwarded = await forwardFetch(request, env);
        if (forwarded) return forwarded;
      }
      return new Response("Not found", { status: 404 });
    },
    async email(message, env, ctx) {
      const name = config.addressEmail?.(message);
      if (name) {
        await config
          .binding(env)
          .getByName(name)
          .deliverEmail(bridgeEmail(message));
      } else {
        await userHandler.email?.(message, env, ctx);
      }
    }
  };
}

// Author's top-level wiring: pick the namespace + say how to address. No
// per-primitive Worker code. ws-upgrade and plain HTTP both just forward; the
// DO's fetch chain routes to WebSocketChannel or 404s.
export default defineWorker(
  {
    binding: (env) => env.MY_DO,
    addressFetch: (req) => new URL(req.url).pathname.split("/")[1] || "default",
    addressEmail: (msg) => msg.to // recipient address → DO instance
  },
  {
    async fetch() {
      return new Response("hello from the app author");
    }
  }
);

export { MyAgentDO, PrimitiveHost };
