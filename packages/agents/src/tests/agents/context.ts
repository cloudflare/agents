import {
  Agent,
  AgentContext,
  getCurrentAgent,
  getCurrentContext,
  type AgentContextInput,
  type Connection,
  type ConnectionContext,
  type Schedule,
  type WSMessage
} from "../../index";

type ContextLifecycle = AgentContextInput["lifecycle"];

type TestContextValue = {
  traceId: string;
  lifecycle: ContextLifecycle;
  callback: string | undefined;
};

type CreateContextCall = {
  lifecycle: ContextLifecycle;
  traceId: string;
  callback: string | undefined;
  hasRequest: boolean;
  hasConnection: boolean;
  hasEmail: boolean;
};

type DestroyContextCall = {
  lifecycle: ContextLifecycle;
  traceId: string;
  callback: string | undefined;
};

type ContextSnapshot = {
  traceId: string | undefined;
  lifecycle: ContextLifecycle | undefined;
  utilityTraceId: string | undefined;
  utilityLifecycle: ContextLifecycle | undefined;
  currentAgentTraceId: string | undefined;
  currentAgentLifecycle: ContextLifecycle | undefined;
};

type ScheduleContextRun = {
  traceId: string | undefined;
  lifecycle: ContextLifecycle | undefined;
  callback: string | undefined;
  utilityTraceId: string | undefined;
  utilityLifecycle: ContextLifecycle | undefined;
};

const CONTEXT_LIFECYCLES: ContextLifecycle[] = [
  "start",
  "request",
  "connect",
  "message",
  "close",
  "email",
  "schedule",
  "queue",
  "alarm",
  "method"
];

function readTraceId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  if (!("traceId" in value)) {
    return undefined;
  }

  const traceId = value.traceId;
  if (typeof traceId !== "string") {
    return undefined;
  }

  return traceId;
}

function readLifecycle(value: unknown): ContextLifecycle | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  if (!("lifecycle" in value)) {
    return undefined;
  }

  const lifecycle = value.lifecycle;
  if (typeof lifecycle !== "string") {
    return undefined;
  }

  return CONTEXT_LIFECYCLES.find((candidate) => candidate === lifecycle);
}

function readUtilityContext(): {
  traceId: string | undefined;
  lifecycle: ContextLifecycle | undefined;
} {
  const context = getCurrentContext();
  return {
    traceId: readTraceId(context),
    lifecycle: readLifecycle(context)
  };
}

function getPathAction(url: string): string {
  const segments = new URL(url).pathname.split("/");
  return segments[segments.length - 1] ?? "";
}

export class TestContextAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  private contextCounter = 0;
  private onContextStartCalls: CreateContextCall[] = [];
  private onContextEndCalls: DestroyContextCall[] = [];

  context = new AgentContext(this, {
    onStart: (input: AgentContextInput): TestContextValue => {
      const callback = "callback" in input ? input.callback : undefined;
      const traceId = `ctx-${++this.contextCounter}`;

      this.onContextStartCalls.push({
        lifecycle: input.lifecycle,
        traceId,
        callback,
        hasRequest: input.request !== undefined,
        hasConnection: input.connection !== undefined,
        hasEmail: input.email !== undefined
      });

      return {
        traceId,
        lifecycle: input.lifecycle,
        callback
      };
    },
    onClose: (context: TestContextValue, input: AgentContextInput): void => {
      this.onContextEndCalls.push({
        lifecycle: input.lifecycle,
        traceId: context.traceId,
        callback: "callback" in input ? input.callback : undefined
      });
    }
  });

  private captureCurrentContext(): ContextSnapshot {
    const utilityContext = readUtilityContext();
    const currentAgent = getCurrentAgent<TestContextAgent>();
    const ctx = this.context;
    const agentCtx = currentAgent.context;

    return {
      traceId: ctx?.traceId,
      lifecycle: ctx?.lifecycle,
      utilityTraceId: utilityContext.traceId,
      utilityLifecycle: utilityContext.lifecycle,
      currentAgentTraceId: agentCtx?.traceId,
      currentAgentLifecycle: agentCtx?.lifecycle
    };
  }

  private getSnapshotPayload() {
    return {
      snapshot: this.captureCurrentContext(),
      createCalls: this.onContextStartCalls,
      destroyCalls: this.onContextEndCalls,
      createLifecycles: this.onContextStartCalls.map((call) => call.lifecycle),
      destroyLifecycles: this.onContextEndCalls.map((call) => call.lifecycle)
    };
  }

  private readFromNestedMethod() {
    return this.captureCurrentContext();
  }

  captureMethodContext() {
    return {
      snapshot: this.captureCurrentContext(),
      createCalls: this.onContextStartCalls,
      destroyCalls: this.onContextEndCalls
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const action = getPathAction(request.url);

    if (action === "error") {
      throw new Error("request handler failure");
    }

    if (action === "inherit") {
      const beforeCreateCount = this.onContextStartCalls.length;
      const nested = this.readFromNestedMethod();
      const afterCreateCount = this.onContextStartCalls.length;

      return Response.json({
        ...this.getSnapshotPayload(),
        nested,
        beforeCreateCount,
        afterCreateCount
      });
    }

    if (action === "external") {
      const utility = readUtilityContext();
      return Response.json({
        ...this.getSnapshotPayload(),
        utilityTraceId: utility.traceId,
        utilityLifecycle: utility.lifecycle
      });
    }

    return Response.json(this.getSnapshotPayload());
  }

  onConnect(connection: Connection, _ctx: ConnectionContext): void {
    connection.send(
      JSON.stringify({
        type: "test:connect",
        ...this.getSnapshotPayload()
      })
    );
  }

  onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message !== "string") {
      return;
    }

    if (message === "error") {
      throw new Error("message handler failure");
    }

    if (message === "inherit") {
      const beforeCreateCount = this.onContextStartCalls.length;
      const nested = this.readFromNestedMethod();
      const afterCreateCount = this.onContextStartCalls.length;

      connection.send(
        JSON.stringify({
          type: "test:inherit",
          ...this.getSnapshotPayload(),
          nested,
          beforeCreateCount,
          afterCreateCount
        })
      );
      return;
    }

    if (message === "snapshot") {
      connection.send(
        JSON.stringify({
          type: "test:snapshot",
          ...this.getSnapshotPayload()
        })
      );
      return;
    }

    connection.send(
      JSON.stringify({
        type: "test:message",
        ...this.getSnapshotPayload()
      })
    );
  }
}

export class TestNoContextAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  async onRequest(): Promise<Response> {
    return Response.json({
      contextKeys: Object.keys(this.context ?? {}),
      hasContextProperties: Object.keys(this.context ?? {}).length > 0,
      utilityContext: getCurrentContext()
    });
  }

  readContextValue() {
    return Object.keys(this.context ?? {}).length > 0
      ? this.context
      : undefined;
  }
}

type AsyncContextValue = {
  traceId: string;
  lifecycle: ContextLifecycle;
};

export class TestAsyncContextAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  private contextCounter = 0;
  private events: string[] = [];

  context = new AgentContext(this, {
    onStart: async (input: AgentContextInput): Promise<AsyncContextValue> => {
      this.events.push(`create:${input.lifecycle}:start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.events.push(`create:${input.lifecycle}:end`);

      return {
        traceId: `async-${++this.contextCounter}`,
        lifecycle: input.lifecycle
      };
    }
  });

  async onRequest(request: Request): Promise<Response> {
    const action = getPathAction(request.url);

    if (action === "reset") {
      this.events = [];
      return Response.json({ ok: true });
    }

    this.events.push("handler:start");
    this.events.push(`handler:lifecycle:${this.context?.lifecycle ?? "none"}`);

    return Response.json({
      events: this.events,
      context: this.context
    });
  }
}

export class TestThrowingContextAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  private handlerCalls = 0;

  context = new AgentContext(this, {
    onStart: (input: AgentContextInput): { traceId: string } => {
      if (
        input.lifecycle === "request" &&
        input.request?.url.includes("throwOnContextStart=true")
      ) {
        throw new Error("onContextStart failure");
      }

      return {
        traceId: `throwing-${Date.now()}`
      };
    }
  });

  async onRequest(request: Request): Promise<Response> {
    const action = getPathAction(request.url);

    if (action === "calls") {
      return Response.json({ handlerCalls: this.handlerCalls });
    }

    this.handlerCalls++;
    return new Response("ok", { status: 200 });
  }
}

export class TestContextScheduleAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  private contextCounter = 0;
  private onContextStartCalls: CreateContextCall[] = [];
  private onContextEndCalls: DestroyContextCall[] = [];
  private runs: ScheduleContextRun[] = [];
  private queueRuns: ScheduleContextRun[] = [];

  context = new AgentContext(this, {
    onStart: (input: AgentContextInput): TestContextValue => {
      const callback = "callback" in input ? input.callback : undefined;
      const traceId = `schedule-${++this.contextCounter}`;

      this.onContextStartCalls.push({
        lifecycle: input.lifecycle,
        traceId,
        callback,
        hasRequest: input.request !== undefined,
        hasConnection: input.connection !== undefined,
        hasEmail: input.email !== undefined
      });

      return {
        traceId,
        lifecycle: input.lifecycle,
        callback
      };
    },
    onClose: (context: TestContextValue, input: AgentContextInput): void => {
      this.onContextEndCalls.push({
        lifecycle: input.lifecycle,
        traceId: context.traceId,
        callback: "callback" in input ? input.callback : undefined
      });
    }
  });

  async triggerSchedule(): Promise<string> {
    const schedule = await this.schedule(0, "scheduledCallback", {
      run: true
    });
    return schedule.id;
  }

  async scheduledCallback(
    _payload: unknown,
    _schedule: Schedule<unknown>
  ): Promise<void> {
    const utility = readUtilityContext();
    this.runs.push({
      traceId: this.context?.traceId,
      lifecycle: this.context?.lifecycle,
      callback: this.context?.callback,
      utilityTraceId: utility.traceId,
      utilityLifecycle: utility.lifecycle
    });
  }

  async triggerQueue(): Promise<string> {
    return this.queue("queuedCallback", { value: "queued" });
  }

  async queuedCallback(_payload: unknown): Promise<void> {
    const utility = readUtilityContext();
    this.queueRuns.push({
      traceId: this.context?.traceId,
      lifecycle: this.context?.lifecycle,
      callback: this.context?.callback,
      utilityTraceId: utility.traceId,
      utilityLifecycle: utility.lifecycle
    });
  }

  async waitForQueueRuns(
    expectedRuns: number,
    timeoutMs = 4000
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.queueRuns.length >= expectedRuns) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.queueRuns.length >= expectedRuns;
  }

  getQueueRuns() {
    return this.queueRuns;
  }

  async waitForRuns(expectedRuns: number, timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.runs.length >= expectedRuns) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.runs.length >= expectedRuns;
  }

  getRuns() {
    return this.runs;
  }

  getCreateCalls() {
    return this.onContextStartCalls;
  }

  getDestroyCalls() {
    return this.onContextEndCalls;
  }

  reset() {
    this.contextCounter = 0;
    this.runs = [];
    this.queueRuns = [];
    this.onContextStartCalls = [];
    this.onContextEndCalls = [];
  }
}
