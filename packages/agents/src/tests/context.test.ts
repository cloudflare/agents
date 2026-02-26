import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { Env } from "./worker";
import worker from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected object");
  }
  return value;
}

function readString(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string
): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  key: string
): string[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    return [];
  }

  return field.filter((entry): entry is string => typeof entry === "string");
}

function readRecordArray(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown>[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    return [];
  }

  return field.filter(isRecord);
}

async function fetchFromWorker(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`http://example.com${path}`, init);
  return worker.fetch(request, env, ctx);
}

const messageQueues = new WeakMap<WebSocket, Record<string, unknown>[]>();

async function connectWS(path: string): Promise<WebSocket> {
  const response = await fetchFromWorker(path, {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);

  const socket = response.webSocket;
  expect(socket).toBeDefined();
  if (!socket) {
    throw new Error("Missing websocket");
  }

  const queue: Record<string, unknown>[] = [];
  messageQueues.set(socket, queue);

  socket.addEventListener("message", (event: MessageEvent) => {
    try {
      const parsed = JSON.parse(event.data as string);
      if (!isRecord(parsed)) {
        return;
      }
      queue.push(parsed);
    } catch {
      // Ignore malformed frames in helper
    }
  });

  socket.accept();
  return socket;
}

async function waitForMessageType(
  socket: WebSocket,
  expectedType: string,
  timeoutMs = 3000
): Promise<Record<string, unknown>> {
  const queue = messageQueues.get(socket);
  if (!queue) {
    throw new Error("Socket queue not initialized");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matchIndex = queue.findIndex(
      (message) => readString(message, "type") === expectedType
    );

    if (matchIndex >= 0) {
      const [message] = queue.splice(matchIndex, 1);
      if (message) {
        return message;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timeout waiting for ${expectedType}`);
}

describe("context api", () => {
  describe("createContext invocation", () => {
    it("creates request context and includes start lifecycle", async () => {
      const room = `ctx-request-${crypto.randomUUID()}`;
      const response = await fetchFromWorker(
        `/agents/test-context-agent/${room}/context`
      );

      expect(response.status).toBe(200);

      const body = asRecord(await response.json());
      const snapshot = asRecord(body.snapshot);
      const createLifecycles = readStringArray(body, "createLifecycles");
      const createCalls = readRecordArray(body, "createCalls");
      const requestCall = createCalls.find(
        (call) => readString(call, "lifecycle") === "request"
      );

      expect(readString(snapshot, "lifecycle")).toBe("request");
      expect(createLifecycles).toContain("start");
      expect(createLifecycles).toContain("request");
      expect(requestCall).toBeDefined();

      if (!requestCall) {
        throw new Error("request call missing");
      }

      expect(readBoolean(requestCall, "hasRequest")).toBe(true);
      expect(readBoolean(requestCall, "hasConnection")).toBe(false);
      expect(readBoolean(requestCall, "hasEmail")).toBe(false);
    });

    it("creates connect and message contexts", async () => {
      const room = `ctx-ws-${crypto.randomUUID()}`;
      const socket = await connectWS(`/agents/test-context-agent/${room}`);

      const connectMessage = await waitForMessageType(socket, "test:connect");
      const connectSnapshot = asRecord(connectMessage.snapshot);
      expect(readString(connectSnapshot, "lifecycle")).toBe("connect");

      socket.send("context");
      const messagePayload = await waitForMessageType(socket, "test:message");
      const messageSnapshot = asRecord(messagePayload.snapshot);
      expect(readString(messageSnapshot, "lifecycle")).toBe("message");

      socket.close();
    });

    it("creates schedule context with callback metadata", async () => {
      const room = `ctx-schedule-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestContextScheduleAgent, room);

      await agent.reset();
      await agent.triggerSchedule();

      const didRun = await agent.waitForRuns(1, 6000);
      expect(didRun).toBe(true);

      const runs = await agent.getRuns();
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]?.lifecycle).toBe("schedule");
      expect(runs[0]?.callback).toBe("scheduledCallback");
      expect(runs[0]?.utilityTraceId).toBe(runs[0]?.traceId);
      expect(runs[0]?.utilityLifecycle).toBe("schedule");

      const createCalls = await agent.getCreateCalls();
      const destroyCalls = await agent.getDestroyCalls();
      expect(
        createCalls.some(
          (call) =>
            call.lifecycle === "schedule" &&
            call.callback === "scheduledCallback"
        )
      ).toBe(true);
      expect(
        destroyCalls.some(
          (call) =>
            call.lifecycle === "schedule" &&
            call.callback === "scheduledCallback"
        )
      ).toBe(true);
    });

    it("creates queue context with callback metadata", async () => {
      const room = `ctx-queue-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestContextScheduleAgent, room);

      await agent.reset();
      await agent.triggerQueue();

      const didRun = await agent.waitForQueueRuns(1, 6000);
      expect(didRun).toBe(true);

      const queueRuns = await agent.getQueueRuns();
      expect(queueRuns.length).toBeGreaterThan(0);
      expect(queueRuns[0]?.lifecycle).toBe("queue");
      expect(queueRuns[0]?.callback).toBe("queuedCallback");
      expect(queueRuns[0]?.utilityTraceId).toBe(queueRuns[0]?.traceId);
      expect(queueRuns[0]?.utilityLifecycle).toBe("queue");

      const createCalls = await agent.getCreateCalls();
      const destroyCalls = await agent.getDestroyCalls();
      expect(
        createCalls.some(
          (call) =>
            call.lifecycle === "queue" && call.callback === "queuedCallback"
        )
      ).toBe(true);
      expect(
        destroyCalls.some(
          (call) =>
            call.lifecycle === "queue" && call.callback === "queuedCallback"
        )
      ).toBe(true);
    });
  });

  describe("method wrapper", () => {
    it("creates method context for custom method calls", async () => {
      const room = `ctx-method-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestContextAgent, room);

      const methodPayload = asRecord(await agent.captureMethodContext());
      const methodSnapshot = asRecord(methodPayload.snapshot);
      const methodTraceId = readString(methodSnapshot, "traceId");

      expect(readString(methodSnapshot, "lifecycle")).toBe("method");
      expect(readString(methodSnapshot, "utilityLifecycle")).toBe("method");
      expect(readString(methodSnapshot, "currentAgentLifecycle")).toBe(
        "method"
      );
      expect(methodTraceId).toBeDefined();

      const response = await fetchFromWorker(
        `/agents/test-context-agent/${room}/snapshot`
      );
      expect(response.status).toBe(200);

      const body = asRecord(await response.json());
      const destroyCalls = readRecordArray(body, "destroyCalls");
      const matchingDestroy = destroyCalls.find(
        (call) =>
          readString(call, "lifecycle") === "method" &&
          readString(call, "traceId") === methodTraceId
      );

      expect(matchingDestroy).toBeDefined();
    });
  });

  describe("context inheritance", () => {
    it("inherits context in custom methods during request", async () => {
      const room = `ctx-inherit-request-${crypto.randomUUID()}`;
      const response = await fetchFromWorker(
        `/agents/test-context-agent/${room}/inherit`
      );
      expect(response.status).toBe(200);

      const body = asRecord(await response.json());
      const snapshot = asRecord(body.snapshot);
      const nested = asRecord(body.nested);

      expect(readString(snapshot, "traceId")).toBe(
        readString(nested, "traceId")
      );
      expect(readString(nested, "lifecycle")).toBe("request");
      expect(readNumber(body, "beforeCreateCount")).toBe(
        readNumber(body, "afterCreateCount")
      );
    });

    it("inherits context in custom methods during message handling", async () => {
      const room = `ctx-inherit-message-${crypto.randomUUID()}`;
      const socket = await connectWS(`/agents/test-context-agent/${room}`);

      await waitForMessageType(socket, "test:connect");

      socket.send("inherit");
      const message = await waitForMessageType(socket, "test:inherit");
      const snapshot = asRecord(message.snapshot);
      const nested = asRecord(message.nested);

      expect(readString(snapshot, "traceId")).toBe(
        readString(nested, "traceId")
      );
      expect(readString(nested, "lifecycle")).toBe("message");
      expect(readNumber(message, "beforeCreateCount")).toBe(
        readNumber(message, "afterCreateCount")
      );

      socket.close();
    });
  });

  describe("getCurrentContext", () => {
    it("is available in external utility functions", async () => {
      const room = `ctx-external-${crypto.randomUUID()}`;
      const response = await fetchFromWorker(
        `/agents/test-context-agent/${room}/external`
      );

      expect(response.status).toBe(200);

      const body = asRecord(await response.json());
      const snapshot = asRecord(body.snapshot);

      expect(readString(body, "utilityTraceId")).toBe(
        readString(snapshot, "traceId")
      );
      expect(readString(body, "utilityLifecycle")).toBe("request");
    });
  });

  describe("destroyContext", () => {
    it("runs after request lifecycle completion", async () => {
      const room = `ctx-destroy-request-${crypto.randomUUID()}`;

      const first = await fetchFromWorker(
        `/agents/test-context-agent/${room}/context`
      );
      expect(first.status).toBe(200);
      const firstBody = asRecord(await first.json());
      const firstSnapshot = asRecord(firstBody.snapshot);
      const requestTraceId = readString(firstSnapshot, "traceId");

      const second = await fetchFromWorker(
        `/agents/test-context-agent/${room}/snapshot`
      );
      expect(second.status).toBe(200);
      const secondBody = asRecord(await second.json());
      const destroyCalls = readRecordArray(secondBody, "destroyCalls");

      const matchingDestroy = destroyCalls.find(
        (call) =>
          readString(call, "lifecycle") === "request" &&
          readString(call, "traceId") === requestTraceId
      );
      expect(matchingDestroy).toBeDefined();
    });

    it("runs after message lifecycle completion", async () => {
      const room = `ctx-destroy-message-${crypto.randomUUID()}`;
      const socket = await connectWS(`/agents/test-context-agent/${room}`);

      await waitForMessageType(socket, "test:connect");

      socket.send("context");
      const firstMessage = await waitForMessageType(socket, "test:message");
      const firstSnapshot = asRecord(firstMessage.snapshot);
      const messageTraceId = readString(firstSnapshot, "traceId");

      socket.send("snapshot");
      const snapshotMessage = await waitForMessageType(socket, "test:snapshot");
      const destroyCalls = readRecordArray(snapshotMessage, "destroyCalls");
      const matchingDestroy = destroyCalls.find(
        (call) =>
          readString(call, "lifecycle") === "message" &&
          readString(call, "traceId") === messageTraceId
      );

      expect(matchingDestroy).toBeDefined();

      socket.close();
    });

    it("runs even when handler throws", async () => {
      const room = `ctx-destroy-error-${crypto.randomUUID()}`;
      const failingResponse = await fetchFromWorker(
        `/agents/test-context-agent/${room}/error`
      );
      expect(failingResponse.status).toBe(500);

      const snapshotResponse = await fetchFromWorker(
        `/agents/test-context-agent/${room}/snapshot`
      );
      expect(snapshotResponse.status).toBe(200);

      const snapshotBody = asRecord(await snapshotResponse.json());
      const destroyLifecycles = readStringArray(
        snapshotBody,
        "destroyLifecycles"
      );
      expect(destroyLifecycles).toContain("request");
    });
  });

  describe("backwards compatibility", () => {
    it("works unchanged when createContext is not overridden", async () => {
      const room = `ctx-none-${crypto.randomUUID()}`;
      const response = await fetchFromWorker(
        `/agents/test-no-context-agent/${room}`
      );

      expect(response.status).toBe(200);

      const body = asRecord(await response.json());
      expect(readBoolean(body, "hasContext")).toBe(false);

      const agent = await getAgentByName(env.TestNoContextAgent, room);
      expect(await agent.readContextValue()).toBeUndefined();
    });
  });

  describe("async createContext", () => {
    it("resolves context before handler execution", async () => {
      const room = `ctx-async-${crypto.randomUUID()}`;

      const resetResponse = await fetchFromWorker(
        `/agents/test-async-context-agent/${room}/reset`
      );
      expect(resetResponse.status).toBe(200);

      const runResponse = await fetchFromWorker(
        `/agents/test-async-context-agent/${room}/run`
      );
      expect(runResponse.status).toBe(200);

      const body = asRecord(await runResponse.json());
      const events = readStringArray(body, "events");
      const context = asRecord(body.context);

      expect(events[0]).toBe("create:request:start");
      expect(events[1]).toBe("create:request:end");
      expect(events[2]).toBe("handler:start");
      expect(events[3]).toBe("handler:lifecycle:request");
      expect(readString(context, "lifecycle")).toBe("request");
    });
  });

  describe("error handling", () => {
    it("fails fast when createContext throws", async () => {
      const room = `ctx-throw-${crypto.randomUUID()}`;

      const failingResponse = await fetchFromWorker(
        `/agents/test-throwing-context-agent/${room}/run?throwCreateContext=true`
      );
      expect(failingResponse.status).toBe(500);

      const callsAfterFailure = await fetchFromWorker(
        `/agents/test-throwing-context-agent/${room}/calls`
      );
      expect(callsAfterFailure.status).toBe(200);
      const callsBody = asRecord(await callsAfterFailure.json());
      expect(readNumber(callsBody, "handlerCalls")).toBe(0);

      const successResponse = await fetchFromWorker(
        `/agents/test-throwing-context-agent/${room}/run`
      );
      expect(successResponse.status).toBe(200);

      const callsAfterSuccess = await fetchFromWorker(
        `/agents/test-throwing-context-agent/${room}/calls`
      );
      expect(callsAfterSuccess.status).toBe(200);
      const callsAfterSuccessBody = asRecord(await callsAfterSuccess.json());
      expect(readNumber(callsAfterSuccessBody, "handlerCalls")).toBe(1);
    });
  });
});
