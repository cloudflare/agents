/**
 * The Durable Object fixture for `ContainerHarnessRuntime`: the real
 * runtime, the real Cap'n Web wire, and a fake container.
 *
 * The container and its daemon live in a module-level registry keyed by the
 * object's id, so they survive an eviction of the Durable Object exactly as
 * a real container does. Everything the runtime touches that would need
 * Docker (`start`, `monitor`, `setInactivityTimeout`, the health probe and
 * the dial) is either the `Container` fake or one of the runtime's two test
 * seams.
 */
import { DurableObject } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { Harness, harnessSessionTag, type HarnessFrame } from "../index";
import { HARNESS_SECRET_HEADER, type HarnessDoorbellBody } from "../protocol";
import { ContainerHarnessRuntime } from "../remote";
import {
  FakeDaemon,
  FakeDaemonState,
  type EchoWireProtocol
} from "./fake-daemon";

export { HarnessTestObject, EchoRuntime } from "./worker";

/** Just enough `Container` for the runtime: no image, no platform. */
export class FakeContainer implements Container {
  running = false;
  startCount = 0;
  /** Test knob: refuse this many dials before answering, like a cold port. */
  failDials = 0;
  failedDials = 0;
  inactivityTimeoutMs: number | undefined;
  lastEnv: Record<string, string> | undefined;
  lastEntrypoint: string[] | undefined;
  #exited: (() => void) | undefined;

  start(options?: ContainerStartupOptions): void {
    this.running = true;
    this.startCount += 1;
    this.lastEnv = options?.env;
    this.lastEntrypoint = options?.entrypoint;
  }

  monitor(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#exited = resolve;
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    const exited = this.#exited;
    this.#exited = undefined;
    exited?.();
  }

  signal(_signo: number): void {}

  getTcpPort(_port: number): Fetcher {
    throw new Error("FakeContainer has no ports; use the dial and probe seams");
  }

  async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    this.inactivityTimeoutMs = Number(durationMs);
  }

  async interceptOutboundHttp(
    _addr: string,
    _binding: Fetcher
  ): Promise<void> {}
  async interceptAllOutboundHttp(_binding: Fetcher): Promise<void> {}
  async interceptOutboundHttps(
    _addr: string,
    _binding: Fetcher
  ): Promise<void> {}

  snapshotDirectory(): Promise<ContainerDirectorySnapshot> {
    throw new Error("FakeContainer does not snapshot");
  }

  snapshotContainer(): Promise<ContainerSnapshot> {
    throw new Error("FakeContainer does not snapshot");
  }

  exec(): Promise<ExecProcess> {
    throw new Error("FakeContainer does not exec");
  }
}

/** One container per object id, outliving every incarnation of the object. */
type Sidecar = {
  readonly container: FakeContainer;
  readonly daemon: FakeDaemonState;
};
const SIDECARS = new Map<string, Sidecar>();

function sidecarFor(id: string): Sidecar {
  const known = SIDECARS.get(id);
  if (known) return known;
  const fresh: Sidecar = {
    container: new FakeContainer(),
    daemon: new FakeDaemonState()
  };
  SIDECARS.set(id, fresh);
  return fresh;
}

/** Serve the daemon on one end of a pair and hand the other to the runtime. */
function dialSidecar(sidecar: Sidecar, secret: string | undefined): WebSocket {
  if (sidecar.container.failDials > 0) {
    sidecar.container.failDials -= 1;
    sidecar.container.failedDials += 1;
    throw new Error("connection refused: the port is not listening yet");
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  sidecar.daemon.secret = secret;
  sidecar.daemon.hold(server);
  newWebSocketRpcSession(server, new FakeDaemon(sidecar.daemon));
  client.accept();
  return client;
}

export class RemoteHarnessTestObject extends DurableObject<Env> {
  readonly #sidecar = sidecarFor(this.ctx.id.toString());
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();
  readonly runtime = new ContainerHarnessRuntime<EchoWireProtocol>({
    id: "container:echo",
    container: this.#sidecar.container,
    sessionName: "remote-test",
    doorbellUrl: "https://example.test/_harness/doorbell",
    launch: { enableInternet: false, env: { ECHO_FLAVOUR: "test" } },
    sessions: this.sessions,
    engine: { id: "echo", options: null, capabilities: new Set(["requests"]) },
    idle: {
      detachAfterIdleMs: 100,
      keepAliveMs: 60_000,
      renewIntervalMs: 2_000,
      stopContainerAfterIdleMs: 60_000
    },
    probe: async () => true,
    dial: async ({ headers }) =>
      dialSidecar(this.#sidecar, headers[HARNESS_SECRET_HEADER])
  });
  readonly harness = new Harness<EchoWireProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.runtime,
    policy: { requestTimeoutMs: 30_000 }
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.webSockets)
    .use(this.harness);

  // ── The developer API, one hop away ──────────────────────────────────────

  async prompt(text: string, operationId?: string) {
    await this.lifecycle.start();
    return this.harness
      .session()
      .prompt(text, operationId === undefined ? {} : { operationId });
  }

  async wait(operationId: string) {
    await this.lifecycle.start();
    return this.harness.session().wait(operationId, { timeoutMs: 20_000 });
  }

  async run(text: string, operationId?: string) {
    const receipt = await this.prompt(text, operationId);
    return { receipt, result: await this.wait(receipt.operationId) };
  }

  // Results cross the test's RPC boundary: keep them to the fields the
  // tests assert, because the full shapes are too deep for the stub types.
  async status() {
    await this.lifecycle.start();
    const status = await this.harness.session().status();
    return {
      state: status.state,
      pendingRequests: [...status.pendingRequests],
      queuedOperations: status.queuedOperations,
      cursor: status.cursor,
      capabilities: [...status.capabilities]
    };
  }

  async requests() {
    await this.lifecycle.start();
    return (await this.harness.session().requests()).map((request) => ({
      requestId: request.requestId,
      type: request.type
    }));
  }

  async reply(requestId: string, decision: "allow" | "deny") {
    await this.lifecycle.start();
    return this.harness
      .session()
      .reply(requestId, { type: "permission", decision });
  }

  async messages() {
    await this.lifecycle.start();
    return (await this.harness.session().messages()).messages.map((message) =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
    );
  }

  /** The Sessions transcript as rows, so a projection can be asserted. */
  async sessionMessages() {
    await this.lifecycle.start();
    const page = await this.sessions.session("main").getRecentHistory(262_144);
    return page.messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts.map((part) => part.type)
    }));
  }

  /** Replay the whole durable log, without tailing. */
  async eventTypes() {
    await this.lifecycle.start();
    const types: string[] = [];
    const controller = new AbortController();
    for await (const event of this.harness.session().events({
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if ("preview" in event) continue;
      const body = event.body;
      types.push(
        body.type === "extension" ? `extension:${body.body.type}` : body.type
      );
    }
    return types;
  }

  /** The wire stamps the base kept on each durable frame, in session order. */
  async wireStamps() {
    await this.lifecycle.start();
    const statuses = await this.streams.list({
      tag: harnessSessionTag("main"),
      limit: 100
    });
    const stamped: {
      seq: number;
      type: string;
      wire?: { seq: number; runtimeId: string };
    }[] = [];
    for (const status of statuses) {
      if (status.cursor === 0) continue;
      let seen = 0;
      for await (const chunk of this.streams.read(status.streamId)) {
        seen += 1;
        const frames =
          chunk.chunk as unknown as readonly HarnessFrame<EchoWireProtocol>[];
        for (const frame of frames) {
          stamped.push({
            seq: frame.seq,
            type: frame.body.type,
            ...(frame.wire === undefined ? {} : { wire: frame.wire })
          });
        }
        if (seen >= status.cursor) break;
      }
    }
    return stamped.sort((left, right) => left.seq - right.seq);
  }

  // ── The container and its daemon ─────────────────────────────────────────

  // The engine diagnostics are opaque JSON, too deep for the RPC stub
  // types: they cross the test boundary as a string.
  async info() {
    await this.lifecycle.start();
    const { engine, ...rest } = await this.runtime.info();
    return { ...rest, engineJson: JSON.stringify(engine ?? null) };
  }

  async refuseDials(count: number) {
    this.#sidecar.container.failDials = count;
  }

  async containerInfo() {
    return {
      running: this.#sidecar.container.running,
      startCount: this.#sidecar.container.startCount,
      failedDials: this.#sidecar.container.failedDials,
      inactivityTimeoutMs: this.#sidecar.container.inactivityTimeoutMs,
      env: this.#sidecar.container.lastEnv ?? {}
    };
  }

  async daemonStats() {
    return this.#sidecar.daemon.stats();
  }

  async runtimeIds() {
    await this.lifecycle.start();
    return {
      daemon: this.#sidecar.daemon.runtimeId,
      stored:
        this.ctx.storage.sql
          .exec<{ runtime_id: string | null; last_wire_seq: number }>(
            "SELECT runtime_id, last_wire_seq FROM cf_agents_harness_remote WHERE session_id = ?",
            "main"
          )
          .toArray()[0] ?? null
    };
  }

  /** What the runtime stored of the engine's own session and transcript. */
  async engineState() {
    await this.lifecycle.start();
    const row =
      this.ctx.storage.sql
        .exec<{
          engine_session_id: string | null;
          restore_pending: number;
          restore_runtime_id: string | null;
        }>(
          `SELECT engine_session_id, restore_pending, restore_runtime_id
           FROM cf_agents_harness_remote WHERE session_id = ?`,
          "main"
        )
        .toArray()[0] ?? null;
    const log = this.ctx.storage.sql
      .exec<{ rows: number; sessions: number }>(
        `SELECT COUNT(*) AS rows, COUNT(DISTINCT engine_session_id) AS sessions
         FROM cf_agents_harness_engine_log WHERE session_id = ?`,
        "main"
      )
      .toArray()[0];
    return { row, rows: log?.rows ?? 0, sessions: log?.sessions ?? 0 };
  }

  async dropSocket() {
    this.#sidecar.daemon.drop();
  }

  /** The engine re-sends the last turn's mirror, as an SDK retry does. */
  async remirror() {
    this.#sidecar.daemon.remirror();
  }

  /** The next engine takes the transcript and starts a fresh session anyway. */
  async refuseResume() {
    this.#sidecar.daemon.refuseResume();
  }

  async crashContainer() {
    this.#sidecar.daemon.crash("container replaced", null);
  }

  async truncateOutbox(throughSeq: number) {
    this.#sidecar.daemon.truncate(throughSeq);
  }

  async preapply(operationId: string, text: string) {
    this.#sidecar.daemon.preapply(operationId, operationId, text);
  }

  async finishParked(operationId: string) {
    this.#sidecar.daemon.finish(operationId);
  }

  // ── The doorbell ─────────────────────────────────────────────────────────

  async secret(): Promise<string | null> {
    await this.lifecycle.start();
    return (
      this.ctx.storage.sql
        .exec<{ secret: string }>(
          "SELECT secret FROM cf_agents_harness_remote WHERE session_id = ?",
          "main"
        )
        .toArray()[0]?.secret ?? null
    );
  }

  async ring(secret: string | null, sessionId = "main"): Promise<number> {
    await this.lifecycle.start();
    const body: HarnessDoorbellBody = {
      sessionId,
      runtimeId: this.#sidecar.daemon.runtimeId,
      highWaterSeq: 0,
      reason: "test"
    };
    const response = await this.runtime.doorbell(
      new Request("https://example.test/_harness/doorbell?name=remote-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret === null ? {} : { [HARNESS_SECRET_HEADER]: secret })
        },
        body: JSON.stringify(body)
      })
    );
    return response.status;
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
