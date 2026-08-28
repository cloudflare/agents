import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  getCurrentAgent as getCurrentRootAgent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "../../index";
import {
  getCurrentAgent,
  Lifecycle,
  LifecycleCapability,
  type DurableObjectCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { WebSockets } from "../../websockets";

type StartupProps = { label: string };

/** Whether a capability hook observed ambient host context, per phase. */
export type CapabilityContextEvent = {
  readonly hasCurrentHost: boolean;
  readonly phase: "alarm" | "request" | "start";
};

/** The ambient context a host hook observed. */
export type HostContextEvent = {
  readonly hostName: string | null;
  readonly phase: "alarm" | "request" | "start";
  readonly requestUrl: string | null;
};

/** The ambient context a WebSocket host hook observed. */
export type WebSocketContextEvent = {
  readonly connectionId: string | null;
  readonly hostName: string | null;
  readonly phase: "close" | "connect" | "message";
  readonly requestUrl: string | null;
};

class StartupAlarmProbe extends LifecycleCapability<StartupProps> {
  constructor() {
    super("startup-alarm-probe");
  }

  async onStart({ props }: { props: StartupProps | undefined }): Promise<void> {
    if (props?.label !== "startup-alarm") return;
    // Pushing during startup defers the physical re-arm until startup
    // completes; the alarm-coalescing test asserts it was applied.
    await this.lifecycle.jobs.push({
      id: "startup-tick",
      fn: "tick",
      time: Date.now() + 60_000
    });
  }

  onJob(): void {}
}

/**
 * Job-queue probe: pushes jobs on behalf of tests, records the ambient
 * context its `onJob` observed, and reports executions through a callback so
 * the host can interleave them with its own events.
 */
class JobProbe extends LifecycleCapability {
  readonly ambientContexts: boolean[] = [];
  readonly #onExecute: (fn: string) => void;

  constructor(onExecute: (fn: string) => void) {
    super("job-probe");
    this.#onExecute = onExecute;
  }

  onJob({ job }: LifecycleJobContext): void {
    this.ambientContexts.push(getCurrentAgent().agent !== undefined);
    this.#onExecute(job.fn);
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }

  async clear(): Promise<void> {
    for (const job of this.lifecycle.jobs.list()) {
      await this.lifecycle.jobs.cancel(job.id);
    }
  }
}

class StartupEventProbe extends LifecycleCapability<StartupProps> {
  constructor() {
    super("startup-probe");
  }

  onStart({ props }: { props: StartupProps | undefined }): void {
    if (props?.label !== "startup-event") return;
    this.lifecycle.events.emit("lifecycle:startup-probe", {
      label: props.label
    });
  }
}

class RoutedCapabilityProbe extends LifecycleCapability {
  constructor() {
    super("route-probe");
  }

  send(payload: unknown): Promise<unknown> {
    return this.lifecycle.routes.toRoot(payload);
  }

  onRoute(context: {
    source: { key: string; data: string } | undefined;
    payload: unknown;
  }): unknown {
    return {
      payload: context.payload,
      source: context.source ?? null
    };
  }
}

class HostBoundaryProbe extends LifecycleCapability {
  constructor() {
    super("host-boundary-probe");
  }

  /** The host name visible outside and inside the host invocation boundary. */
  async observeHostThroughBoundary(): Promise<{
    outsideHostName: string | null;
    insideHostName: string | null;
  }> {
    const read = () =>
      getCurrentAgent<PlainLifecycleObject>().agent?.lifecycle.name ?? null;
    return {
      outsideHostName: read(),
      insideHostName: (await this.lifecycle.runInHostContext(read)) as
        | string
        | null
    };
  }
}

class CapabilityContextProbe implements DurableObjectCapability<StartupProps> {
  readonly events: CapabilityContextEvent[] = [];

  onStart(): void {
    this.#capture("start");
  }

  onRequest(): void {
    this.#capture("request");
  }

  #capture(phase: CapabilityContextEvent["phase"]): void {
    this.events.push({
      hasCurrentHost: getCurrentAgent().agent !== undefined,
      phase
    });
  }
}

function currentLifecycleContext(
  phase: HostContextEvent["phase"]
): HostContextEvent {
  const { agent: host, request } = getCurrentAgent<PlainLifecycleObject>();
  return {
    hostName: host?.lifecycle.name ?? null,
    phase,
    requestUrl: request?.url ?? null
  };
}

function currentWebSocketContext(
  phase: WebSocketContextEvent["phase"]
): WebSocketContextEvent {
  const {
    agent: host,
    connection,
    request
  } = getCurrentAgent<PlainLifecycleObject>();
  return {
    connectionId: connection?.id ?? null,
    hostName: host?.lifecycle.name ?? null,
    phase,
    requestUrl: request?.url ?? null
  };
}

/**
 * Callables target served by the WebSockets capability. The private
 * field proves methods run with the real instance as `this`.
 */
class PlainHostCallables extends RpcTarget {
  readonly #greeting = "host";

  add(a: number, b: number): number {
    return a + b;
  }

  fail(message: string): never {
    throw new Error(message);
  }

  hostContext(): boolean {
    return getCurrentAgent().agent !== undefined;
  }

  greeting(): string {
    return this.#greeting;
  }

  streamNumbers(): ReadableStream<number> {
    return new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      }
    });
  }
}

/**
 * A plain Durable Object composed with Lifecycle and an assortment of probe
 * capabilities. The Lifecycle test suites drive it to prove phase ordering,
 * shared alarm arbitration, context boundaries, routing, identity, and
 * hibernating WebSockets on a non-Agent host.
 */
export class PlainLifecycleObject extends DurableObject<Cloudflare.Env> {
  readonly #events: string[] = [];
  readonly #capabilityContexts = new CapabilityContextProbe();
  readonly #startupAlarm = new StartupAlarmProbe();
  readonly #startupEvent = new StartupEventProbe();
  readonly #routedCapability = new RoutedCapabilityProbe();
  readonly #hostBoundary = new HostBoundaryProbe();
  readonly #webSockets = new WebSockets({
    handlers: {
      onConnect: (connection) => {
        this.#webSocketContexts.push(currentWebSocketContext("connect"));
        connection.send(`connected:${this.lifecycle.name}`);
      },
      onMessage: (connection, message) => {
        this.#webSocketContexts.push(currentWebSocketContext("message"));
        connection.send(`echo:${String(message)}`);
      },
      onClose: () => {
        this.#webSocketContexts.push(currentWebSocketContext("close"));
      }
    },
    callables: new PlainHostCallables()
  });
  readonly #hostContexts: HostContextEvent[] = [];
  readonly #webSocketContexts: WebSocketContextEvent[] = [];
  readonly #jobProbe = new JobProbe((fn) => {
    this.#events.push(`capability:job:${fn}`);
  });
  readonly #hostJobContexts: boolean[] = [];

  readonly lifecycle = Lifecycle.install<Cloudflare.Env, StartupProps>(this)
    .use(this.#capabilityContexts)
    .use(this.#startupAlarm)
    .use(this.#startupEvent)
    .use(this.#routedCapability)
    .use(this.#hostBoundary)
    .use(this.#webSockets)
    .use({
      onStart: ({ props }) => {
        this.#events.push(`capability:start:${props?.label ?? "none"}`);
      },
      onRequest: ({ request }) => {
        this.#events.push("capability:request");
        if (new URL(request.url).searchParams.has("capability")) {
          return Response.json(this.#events);
        }
      }
    } satisfies DurableObjectCapability<StartupProps>)
    .use(this.#jobProbe)
    .use({
      dispose: () => {
        this.#events.push("dispose:first");
      }
    })
    .use({
      dispose: () => {
        this.#events.push("dispose:second");
      }
    });

  onStart(props?: StartupProps): void {
    this.#hostContexts.push(currentLifecycleContext("start"));
    this.#events.push(`host:start:${props?.label ?? "none"}`);
  }

  onRequest(request: Request): Response {
    this.#hostContexts.push(currentLifecycleContext("request"));
    this.#events.push("host:request");
    return Response.json({
      name: this.lifecycle.name,
      events: this.#events,
      hasInternalPropsHeader: request.headers.has("x-agents-lifecycle-props")
    });
  }

  onAlarm(): void {
    this.#hostContexts.push(currentLifecycleContext("alarm"));
    this.#events.push("host:alarm");
  }

  onJob({ job }: LifecycleJobContext): void {
    this.#hostJobContexts.push(
      getCurrentAgent<PlainLifecycleObject>().agent === this
    );
    this.#events.push(`host:job:${job.fn}`);
  }

  installHandlersAgainForTest(): string {
    try {
      this.lifecycle.installHandlers();
      return "installed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  useCapabilityAfterStartForTest(): string {
    try {
      this.lifecycle.use({});
      return "added";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async seedLegacyNameForTest(name: string): Promise<void> {
    await this.ctx.storage.put("__ps_name", name);
  }

  /** Arm a raw platform alarm with no due jobs (a bare alarm wake). */
  async scheduleAlarm(): Promise<void> {
    await this.lifecycle.start();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  /** Push one backdated capability job so the alarm event loop drives it. */
  async pushDueProbeJob(fn: string): Promise<void> {
    await this.lifecycle.start();
    await this.#jobProbe.push({ fn, time: Date.now() - 1 });
  }

  /** Push one backdated host job so the alarm event loop drives it. */
  async pushDueHostJob(fn: string): Promise<void> {
    await this.lifecycle.start();
    await this.lifecycle.jobs.push({ fn, time: Date.now() - 1 });
  }

  getJobContexts(): {
    readonly capability: readonly boolean[];
    readonly host: readonly boolean[];
  } {
    return {
      capability: this.#jobProbe.ambientContexts,
      host: this.#hostJobContexts
    };
  }

  /**
   * Replace every probe- and host-owned job with the given future wake
   * times, then report the physical alarm derived from the queue.
   */
  async setQueueJobs(options: {
    capabilityTimes?: number[];
    hostTime?: number;
    exclusiveTime?: number;
  }): Promise<number | null> {
    await this.lifecycle.start();
    await this.#jobProbe.clear();
    for (const job of this.lifecycle.jobs.list()) {
      await this.lifecycle.jobs.cancel(job.id);
    }
    for (const [index, time] of (options.capabilityTimes ?? []).entries()) {
      await this.#jobProbe.push({ id: `probe-${index}`, fn: "tick", time });
    }
    if (options.hostTime !== undefined) {
      await this.lifecycle.jobs.push({
        id: "host-tick",
        fn: "tick",
        time: options.hostTime
      });
    }
    if (options.exclusiveTime !== undefined) {
      await this.#jobProbe.push({
        id: "probe-exclusive",
        fn: "tick",
        time: options.exclusiveTime,
        exclusive: true
      });
    }
    return this.ctx.storage.getAlarm();
  }

  async routeCapability(payload: unknown): Promise<unknown> {
    return this.#routedCapability.send(payload);
  }

  async probeHostBoundary(): Promise<{
    outsideHostName: string | null;
    insideHostName: string | null;
  }> {
    await this.lifecycle.start();
    return this.#hostBoundary.observeHostThroughBoundary();
  }

  async getEvents(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return this.#events;
  }

  async disposeCapabilities(): Promise<readonly string[]> {
    await this.lifecycle.start();
    await this.lifecycle.dispose();
    return this.#events.filter((event) => event.startsWith("dispose:"));
  }

  contextAccessorsAreAliases(): boolean {
    return getCurrentAgent === getCurrentRootAgent;
  }

  async getCapabilityContextEvents(): Promise<
    readonly CapabilityContextEvent[]
  > {
    await this.lifecycle.start();
    return this.#capabilityContexts.events;
  }

  async getHostContextEvents(): Promise<readonly HostContextEvent[]> {
    await this.lifecycle.start();
    return this.#hostContexts;
  }

  async getWebSocketContextEvents(): Promise<readonly WebSocketContextEvent[]> {
    await this.lifecycle.start();
    return this.#webSocketContexts;
  }

  async startFromRpc(props: StartupProps): Promise<readonly string[]> {
    await this.lifecycle.start(props);
    return this.#events;
  }

  async startWithAlarmContribution(): Promise<number | null> {
    await this.lifecycle.start({ label: "startup-alarm" });
    return this.ctx.storage.getAlarm();
  }

  async startFromForeignContext(props: StartupProps): Promise<{
    readonly capability: readonly CapabilityContextEvent[];
    readonly host: readonly HostContextEvent[];
  }> {
    return agentContext.run(
      {
        agent: { foreign: true },
        connection: undefined,
        request: new Request("https://foreign.example.com/request"),
        email: undefined
      },
      async () => {
        await this.lifecycle.start(props);
        return {
          capability: this.#capabilityContexts.events,
          host: this.#hostContexts
        };
      }
    );
  }
}

class FailingStartProbe extends LifecycleCapability {
  failuresRemaining = 1;

  constructor() {
    super("failing-start-probe");
  }

  onStart(): void {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("intentional startup failure");
    }
  }
}

/**
 * Proves failed Lifecycle startup is retryable: its first capability start
 * throws once, and the host start must not run until a later attempt
 * succeeds.
 */
export class RetryableStartObject extends DurableObject<Cloudflare.Env> {
  readonly #failingStart = new FailingStartProbe();
  readonly lifecycle = Lifecycle.install(this).use(this.#failingStart);
  hostStarts = 0;

  onStart(): void {
    this.hostStarts += 1;
  }

  async tryStart(): Promise<string> {
    try {
      await this.lifecycle.start();
      return "started";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  getHostStarts(): number {
    return this.hostStarts;
  }
}
