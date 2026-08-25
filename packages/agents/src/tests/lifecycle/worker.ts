import { DurableObject } from "cloudflare:workers";
import {
  getCurrentAgent as getCurrentRootAgent,
  routeAgentRequest,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "../../index";
import {
  getCurrentAgent,
  Lifecycle,
  LifecycleCapability,
  type Connection,
  type DurableObjectCapability,
  type WSMessage
} from "../../lifecycle";
import { setLifecycleEventSink } from "../../lifecycle/durable-object-lifecycle";
import { MCPClientManager } from "../../mcp/client";
import { MCPConnectionState } from "../../mcp/client-connection";
import { Scheduler, type Schedule } from "../../schedules";

export type Env = {
  PlainLifecycleObject: DurableObjectNamespace<PlainLifecycleObject>;
  PlainMcpClientObject: DurableObjectNamespace<PlainMcpClientObject>;
  ScheduledLifecycleObject: DurableObjectNamespace<ScheduledLifecycleObject>;
  SchedulerHarnessObject: DurableObjectNamespace<SchedulerHarnessObject>;
  SchedulerStartupWarnObject: DurableObjectNamespace<SchedulerStartupWarnObject>;
};

type StartupProps = { label: string };

type CapabilityContextEvent = {
  readonly hasCurrentHost: boolean;
  readonly phase: "alarm" | "request" | "start";
};

type HostContextEvent = {
  readonly hostName: string | null;
  readonly phase: "alarm" | "request" | "start";
  readonly requestUrl: string | null;
};

type WebSocketContextEvent = {
  readonly connectionId: string | null;
  readonly hostName: string | null;
  readonly phase: "close" | "connect" | "message";
  readonly requestUrl: string | null;
};

class StartupAlarmProbe extends LifecycleCapability<StartupProps> {
  #nextAlarm: number | null = null;

  constructor() {
    super("startup-alarm-probe");
  }

  async onStart({ props }: { props: StartupProps | undefined }): Promise<void> {
    if (props?.label !== "startup-alarm") return;
    this.#nextAlarm = Date.now() + 60_000;
    await this.lifecycle.alarms.rearm();
  }

  getNextAlarm(): number | null {
    return this.#nextAlarm;
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

class CapabilityContextProbe implements DurableObjectCapability<StartupProps> {
  readonly events: CapabilityContextEvent[] = [];

  onStart(): void {
    this.#capture("start");
  }

  onRequest(): void {
    this.#capture("request");
  }

  onAlarm(): void {
    this.#capture("alarm");
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

export class PlainLifecycleObject extends DurableObject<Env> {
  readonly #events: string[] = [];
  readonly #capabilityContexts = new CapabilityContextProbe();
  readonly #startupAlarm = new StartupAlarmProbe();
  readonly #startupEvent = new StartupEventProbe();
  readonly #routedCapability = new RoutedCapabilityProbe();
  readonly #hostContexts: HostContextEvent[] = [];
  readonly #webSocketContexts: WebSocketContextEvent[] = [];
  #firstAlarm: number | null = null;
  #secondAlarm: number | null = null;
  #exclusiveAlarm: number | null = null;
  #hostAlarm: number | null = null;
  readonly #capabilityAlarmContexts: boolean[] = [];
  readonly #hostAlarmContexts: boolean[] = [];

  readonly lifecycle = Lifecycle.install<Env, StartupProps>(this)
    .use(this.#capabilityContexts)
    .use(this.#startupAlarm)
    .use(this.#startupEvent)
    .use(this.#routedCapability)
    .use({
      onStart: ({ props }) => {
        this.#events.push(`capability:start:${props?.label ?? "none"}`);
      },
      onRequest: ({ request }) => {
        this.#events.push("capability:request");
        if (new URL(request.url).searchParams.has("capability")) {
          return Response.json(this.#events);
        }
      },
      onAlarm: () => {
        this.#events.push("capability:alarm");
      }
    } satisfies DurableObjectCapability<StartupProps>)
    .use({
      getNextAlarm: () => {
        this.#capabilityAlarmContexts.push(
          getCurrentAgent().agent !== undefined
        );
        return this.#firstAlarm;
      }
    })
    .use({
      getNextAlarm: () => this.#secondAlarm
    })
    .use({
      getNextAlarm: () =>
        this.#exclusiveAlarm === null
          ? null
          : { time: this.#exclusiveAlarm, exclusive: true }
    })
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

  getNextAlarm(): number | null {
    this.#hostAlarmContexts.push(
      getCurrentAgent<PlainLifecycleObject>().agent === this
    );
    return this.#hostAlarm;
  }

  onConnect(connection: Connection): void {
    this.#webSocketContexts.push(currentWebSocketContext("connect"));
    connection.send(`connected:${this.lifecycle.name}`);
  }

  onMessage(connection: Connection, message: WSMessage): void {
    this.#webSocketContexts.push(currentWebSocketContext("message"));
    connection.send(`echo:${String(message)}`);
  }

  onClose(): void {
    this.#webSocketContexts.push(currentWebSocketContext("close"));
  }

  installHandlersAgainForTest(): string {
    try {
      this.lifecycle.installHandlers();
      return "installed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async seedLegacyNameForTest(name: string): Promise<void> {
    await this.ctx.storage.put("__ps_name", name);
  }

  async scheduleAlarm(): Promise<void> {
    await this.lifecycle.start();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  getAlarmContributionContexts(): {
    readonly capability: readonly boolean[];
    readonly host: readonly boolean[];
  } {
    return {
      capability: this.#capabilityAlarmContexts,
      host: this.#hostAlarmContexts
    };
  }

  async setAlarmContributions(
    first: number | null,
    second: number | null,
    host: number | null,
    exclusive: number | null = null
  ): Promise<number | null> {
    await this.lifecycle.start();
    this.#firstAlarm = first;
    this.#secondAlarm = second;
    this.#hostAlarm = host;
    this.#exclusiveAlarm = exclusive;
    await this.lifecycle.rearmAlarm();
    return this.ctx.storage.getAlarm();
  }

  async routeCapability(payload: unknown): Promise<unknown> {
    return this.#routedCapability.send(payload);
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

type ScheduledLifecycleResult = {
  readonly events: readonly string[];
  readonly message: string | null;
  readonly callbackScheduleId: string | null;
  readonly callbackScheduleMessage: string | null;
  readonly alarm: number | null;
  readonly scheduleCount: number;
};

export class ScheduledLifecycleObject extends DurableObject<Env> {
  readonly #events: string[] = [];
  #message: string | null = null;
  #callbackScheduleId: string | null = null;
  #callbackScheduleMessage: string | null = null;

  readonly scheduler = new Scheduler(this);

  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  reminder(
    payload: { message: string },
    schedule: Schedule<{ message: string }>
  ): void {
    this.#events.push(
      getCurrentAgent<ScheduledLifecycleObject>().agent === this
        ? "callback:context"
        : "callback:missing-context"
    );
    this.#message = payload.message;
    this.#callbackScheduleId = schedule.id;
    this.#callbackScheduleMessage = schedule.payload.message;
  }

  onAlarm(): void {
    this.#events.push(
      getCurrentAgent<ScheduledLifecycleObject>().agent === this
        ? "host:context"
        : "host:missing-context"
    );
  }

  async scheduleReminderWithFailingEventSink(message: string): Promise<string> {
    setLifecycleEventSink(this.lifecycle, () => {
      throw new Error("intentional Lifecycle event sink failure");
    });
    return this.scheduleReminder(message);
  }

  async scheduleReminder(message: string): Promise<string> {
    await this.lifecycle.start();
    const schedule = await this.scheduler.schedule(86_400, "reminder", {
      message
    });
    const past = Math.floor(Date.now() / 1000) - 1;
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
      past,
      schedule.id
    );
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return schedule.id;
  }

  async getSchedulerResult(): Promise<ScheduledLifecycleResult> {
    await this.lifecycle.start();
    return {
      events: this.#events,
      message: this.#message,
      callbackScheduleId: this.#callbackScheduleId,
      callbackScheduleMessage: this.#callbackScheduleMessage,
      alarm: await this.ctx.storage.getAlarm(),
      scheduleCount: this.scheduler.getSchedules().length
    };
  }
}

type SchedulerInvocation = {
  readonly callback: string;
  readonly payload: unknown;
  readonly scheduleId: string;
  readonly hadHostContext: boolean;
};

/**
 * Minimal real host for capability-level Scheduler tests: a plain Durable
 * Object with only the Scheduler installed, so tests can drive the capability
 * through a real Lifecycle, real storage, and real platform alarms.
 */
export class SchedulerHarnessObject extends DurableObject<Env> {
  readonly invocations: SchedulerInvocation[] = [];
  readonly callbackErrors: string[] = [];
  failuresBeforeSuccess = 0;
  disableAlarmsOnNextCallback = false;

  readonly scheduler = new Scheduler(this, {
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    hungScheduleTimeoutSeconds: 60,
    onError: (error) => {
      this.callbackErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  #record(
    callback: string,
    payload: unknown,
    schedule: Schedule<unknown>
  ): void {
    this.invocations.push({
      callback,
      payload,
      scheduleId: schedule.id,
      hadHostContext: getCurrentAgent<SchedulerHarnessObject>().agent === this
    });
  }

  async remind(payload: unknown, schedule: Schedule<unknown>): Promise<void> {
    if (this.disableAlarmsOnNextCallback) {
      this.disableAlarmsOnNextCallback = false;
      await this.lifecycle.disableAlarms();
    }
    this.#record("remind", payload, schedule);
  }

  flaky(payload: unknown, schedule: Schedule<unknown>): void {
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new Error("flaky failure");
    }
    this.#record("flaky", payload, schedule);
  }

  broken(): void {
    throw new Error("broken callback");
  }
}

/**
 * Captures the non-idempotent-schedule warning emitted while its own real
 * onStart creates schedules, proving Lifecycle startup state drives it.
 */
export class SchedulerStartupWarnObject extends DurableObject<Env> {
  readonly #capturedWarnings: string[] = [];

  readonly scheduler = new Scheduler(this);
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  maintenance(): void {}

  async onStart(): Promise<void> {
    await this.#captureWarnings(async () => {
      await this.scheduler.schedule(60, "maintenance", "a");
      await this.scheduler.schedule(60, "maintenance", "b");
      await this.scheduler.schedule(120, "maintenance", "c", {
        idempotent: true
      });
      await this.scheduler.schedule("0 * * * *", "maintenance");
    });
  }

  async warnings(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return this.#capturedWarnings;
  }

  async scheduleOutsideStartup(): Promise<number> {
    await this.lifecycle.start();
    const before = this.#capturedWarnings.length;
    await this.#captureWarnings(async () => {
      await this.scheduler.schedule(60, "maintenance", "later");
    });
    return this.#capturedWarnings.length - before;
  }

  async #captureWarnings(run: () => Promise<void>): Promise<void> {
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      this.#capturedWarnings.push(String(args[0]));
      original.apply(console, args);
    };
    try {
      await run();
    } finally {
      console.warn = original;
    }
  }
}

export class PlainMcpClientObject extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("plain-lifecycle-object", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  onRequest(): Response {
    return Response.json({
      connectionIds: Object.keys(this.mcp.mcpConnections),
      states: Object.fromEntries(
        Object.entries(this.mcp.mcpConnections).map(([id, connection]) => [
          id,
          connection.connectionState
        ])
      ),
      storedServerCount: this.mcp.listServers().length
    });
  }

  async prepareRestorableServer(): Promise<void> {
    await this.lifecycle.start();
    await this.mcp.registerServer("server", {
      name: "Test server",
      url: "https://mcp.example.com",
      callbackUrl: "https://example.com/callback",
      transport: { type: "auto" }
    });
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_mcp_servers SET auth_url = ? WHERE id = ?",
      "https://auth.example.com/authorize",
      "server"
    );
  }

  async prepareOAuthCallback(): Promise<string> {
    await this.lifecycle.start();
    this.mcp.configureOAuthCallback({
      customHandler: (result) => Response.json(result)
    });
    await this.mcp.registerServer("callback-server", {
      name: "Test server",
      url: "https://mcp.example.com",
      callbackUrl: "https://example.com/callback",
      transport: { type: "auto" }
    });

    const connection = this.mcp.mcpConnections["callback-server"];
    const authProvider = connection.options.transport.authProvider;
    if (!authProvider?.state) {
      throw new Error("Expected a stateful default OAuth provider");
    }
    connection.connectionState = MCPConnectionState.AUTHENTICATING;
    return authProvider.state();
  }

  async startFreshOAuthFlow(): Promise<unknown> {
    await this.lifecycle.start();
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authorizationServerUrl = "https://auth.example.com";

    const oauthFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.url === serverUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`
          }
        });
      }

      if (request.url === resourceMetadataUrl) {
        return Response.json({
          resource: serverUrl,
          authorization_servers: [authorizationServerUrl]
        });
      }

      if (
        url.origin === authorizationServerUrl &&
        url.pathname.includes(".well-known")
      ) {
        return Response.json({
          issuer: authorizationServerUrl,
          authorization_endpoint: `${authorizationServerUrl}/authorize`,
          token_endpoint: `${authorizationServerUrl}/token`,
          registration_endpoint: `${authorizationServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        });
      }

      if (
        url.origin === authorizationServerUrl &&
        url.pathname === "/register" &&
        request.method === "POST"
      ) {
        return Response.json({
          client_id: "test-client-id",
          redirect_uris: ["https://example.com/callback"]
        });
      }

      return new Response(`Unexpected OAuth test request: ${request.url}`, {
        status: 500
      });
    };

    await this.mcp.registerServer("fresh-oauth-server", {
      name: "Fresh OAuth server",
      url: serverUrl,
      callbackUrl: "https://example.com/callback",
      transport: { type: "streamable-http", fetch: oauthFetch }
    });

    return this.mcp.connectToServer("fresh-oauth-server");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env, {
        props: { label: "routed" }
      })) ?? new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
