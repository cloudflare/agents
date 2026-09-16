/**
 * A Durable Object that exists only to prove the Worker half of this example
 * loads and composes inside the real runtime.
 *
 * The remote runtime's own behaviour is covered where it lives, in the
 * shared package; the container daemon's is covered in `container/src/tests`
 * against a real socket. What is left for here is the seam between them: the
 * engine spec this example builds, and the fact that `src/server.ts` can be
 * imported into a Worker without dragging a Node module in with it.
 */
import { DurableObject } from "cloudflare:workers";
import { Harness } from "@cloudflare/agents-next-harness";
import { ContainerHarnessRuntime } from "@cloudflare/agents-next-harness/remote";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { claudeCode } from "../claude-code-protocol";
import { ClaudeCodeSession } from "../server";

export class ClaudeCodeProtocolTestObject extends DurableObject<Env> {
  /** The spec the example hands the container runtime. */
  spec() {
    const spec = claudeCode({
      model: "claude-opus-5",
      permissionMode: "default",
      allowedTools: ["Read"],
      ask: ["Bash"],
      budget: { maxUsd: 5 }
    });
    return {
      id: spec.id,
      // As JSON: `JsonValue` is recursive, and the Durable Object RPC type
      // mapping cannot walk it without exploding.
      optionsJson: JSON.stringify(spec.options),
      capabilities: [...spec.capabilities]
    };
  }

  /** The session class is a constructible Durable Object in this runtime. */
  sessionClassName() {
    return ClaudeCodeSession.name;
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };

// ── Live daemon fixture ──────────────────────────────────────────────────

/**
 * The same runtime the example ships, pointed at a real `harnessd` running
 * on the host (echo engine) instead of a container: the dial and probe seams
 * reach it over localhost, and a fake `Container` stands in for the
 * platform. This exercises the daemon, its outbox, the Cap'n Web wire and
 * `ContainerHarnessRuntime` together, which no unit test does.
 */
class HostContainer implements Container {
  running = false;
  inactivityTimeoutMs: number | undefined;
  #exited: (() => void) | undefined;
  start(): void {
    this.running = true;
  }
  monitor(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#exited = resolve;
    });
  }
  async destroy(): Promise<void> {
    this.running = false;
    this.#exited?.();
    this.#exited = undefined;
  }
  signal(): void {}
  getTcpPort(): Fetcher {
    throw new Error("use the dial and probe seams");
  }
  async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    this.inactivityTimeoutMs = Number(durationMs);
  }
  async interceptOutboundHttp(): Promise<void> {}
  async interceptAllOutboundHttp(): Promise<void> {}
  async interceptOutboundHttps(): Promise<void> {}
  snapshotDirectory(): Promise<ContainerDirectorySnapshot> {
    throw new Error("unsupported");
  }
  snapshotContainer(): Promise<ContainerSnapshot> {
    throw new Error("unsupported");
  }
  exec(): Promise<ExecProcess> {
    throw new Error("unsupported");
  }
}

export class LiveDaemonTestObject extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();
  readonly container = new HostContainer();
  readonly runtime = new ContainerHarnessRuntime({
    id: "container:echo",
    container: this.container,
    port: 18790,
    launch: { enableInternet: false },
    sessions: this.sessions,
    engine: { id: "echo", options: null, capabilities: new Set(["requests"]) },
    idle: {
      detachAfterIdleMs: 300,
      renewIntervalMs: 5_000,
      stopContainerAfterIdleMs: 60_000
    },
    probe: async () => {
      const response = await fetch(`${this.env.HARNESSD_URL}/healthz`, {
        method: "HEAD"
      });
      return response.ok;
    },
    dial: async ({ path, headers }) => {
      const response = await fetch(`${this.env.HARNESSD_URL}${path}`, {
        headers: { ...headers, Upgrade: "websocket" }
      });
      const socket = response.webSocket;
      if (!socket)
        throw new Error(`daemon refused the upgrade: ${response.status}`);
      socket.accept();
      return socket;
    }
  });
  readonly harness = new Harness({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.runtime,
    policy: { requestTimeoutMs: 20_000 }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.harness);

  /** The daemon was started with a fixed secret; hand it to the runtime's row. */
  async #ready(): Promise<void> {
    await this.lifecycle.start();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO cf_agents_harness_remote
         (session_id, secret, runtime_id, launch_digest, last_wire_seq, updated_at)
       VALUES ('main', ?, NULL, NULL, 0, ?)`,
      this.env.HARNESSD_SECRET,
      Date.now()
    );
  }

  async run(text: string) {
    await this.#ready();
    const session = this.harness.session();
    const receipt = await session.prompt(text);
    const result = await session.wait(receipt.operationId, {
      timeoutMs: 30_000
    });
    const page = await session.messages();
    return {
      status: result.status,
      stopReason: result.stopReason.type,
      raw: JSON.stringify(result.raw ?? null),
      messages: page.messages.map((message) =>
        message.parts.map((part) => part.text ?? "").join("")
      )
    };
  }

  async ask(text: string, decision: "allow" | "deny") {
    await this.#ready();
    const session = this.harness.session();
    const receipt = await session.prompt(text);
    let request: { requestId: string; type: string } | undefined;
    for (let i = 0; i < 100 && !request; i++) {
      const open = await session.requests();
      request = open[0];
      if (!request) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!request) throw new Error("the daemon never raised a request");
    const blocked = (await session.status()).state;
    const replied = await session.reply(request.requestId, {
      type: "permission",
      decision
    });
    const result = await session.wait(receipt.operationId, {
      timeoutMs: 30_000
    });
    return {
      requestType: request.type,
      blocked,
      accepted: replied.accepted,
      status: result.status
    };
  }

  async interruptSlow() {
    await this.#ready();
    const session = this.harness.session();
    const receipt = await session.prompt("slow down");
    for (let i = 0; i < 50; i++) {
      if ((await session.status()).state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const interrupted = await session.interrupt();
    const result = await session.wait(receipt.operationId, {
      timeoutMs: 30_000
    });
    return {
      target: interrupted.operationId,
      operationId: receipt.operationId,
      status: result.status,
      stopReason: result.stopReason.type
    };
  }

  /** Start a turn the daemon finishes on its own after a few seconds. */
  async startSlow() {
    await this.#ready();
    const session = this.harness.session();
    const receipt = await session.prompt("slow and steady");
    for (let i = 0; i < 50; i++) {
      if ((await session.status()).state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return receipt.operationId;
  }

  async waitFor(operationId: string) {
    await this.#ready();
    const result = await this.harness
      .session()
      .wait(operationId, { timeoutMs: 30_000 });
    const page = await this.harness.session().messages();
    return {
      status: result.status,
      stopReason: result.stopReason.type,
      messages: page.messages.map((message) =>
        message.parts.map((part) => part.text ?? "").join("")
      )
    };
  }

  async eventTypes() {
    await this.#ready();
    const controller = new AbortController();
    const types: string[] = [];
    for await (const event of this.harness.session().events({
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if ("preview" in event) continue;
      types.push(
        event.body.type === "extension"
          ? `extension:${event.body.body.type}`
          : `${event.body.type}${event.wire ? "@wire" : ""}`
      );
    }
    return types;
  }

  async info() {
    await this.#ready();
    const { engine, ...rest } = await this.runtime.info();
    return {
      ...rest,
      engineJson: JSON.stringify(engine ?? null),
      inactivityTimeoutMs: this.container.inactivityTimeoutMs
    };
  }
}
