import {
  AgentCard,
  StreamResponse,
  Task,
  TaskState,
  type StreamResponse as StreamResponseValue
} from "@a2a-js/sdk";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { describe, expect, it, vi } from "vitest";
import { discoverAgent, sendStreamingTask } from "../src/a2a-client";
import { buildAgentCard } from "../src/agent-card";

describe("bounded A2A client", () => {
  it("discovers the JSON-RPC endpoint from the Agent Card", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        AgentCard.toJSON(
          buildAgentCard("https://agent.example", {
            description: "Coordinates a specialist review.",
            name: "Coordinator Agent",
            route: "coordinator",
            skillId: "coordinate-specialist-review"
          })
        )
      )
    );

    await expect(
      discoverAgent("https://agent.example/card", fetcher)
    ).resolves.toMatchObject({
      endpoint: "https://agent.example/coordinator/a2a"
    });
  });

  it("selects only a JSON-RPC interface matching the supported version", async () => {
    const card = buildAgentCard("https://agent.example", {
      description: "Coordinates a specialist review.",
      name: "Coordinator Agent",
      route: "coordinator",
      skillId: "coordinate-specialist-review"
    });
    card.supportedInterfaces.unshift({
      url: "https://legacy.example/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "0.3",
      tenant: ""
    });
    const fetcher = vi.fn(async () => Response.json(AgentCard.toJSON(card)));

    await expect(
      discoverAgent("https://agent.example/card", fetcher)
    ).resolves.toMatchObject({
      endpoint: "https://agent.example/coordinator/a2a"
    });
  });

  it("rejects an Agent Card without a matching protocol version", async () => {
    const card = buildAgentCard("https://agent.example", {
      description: "Coordinates a specialist review.",
      name: "Coordinator Agent",
      route: "coordinator",
      skillId: "coordinate-specialist-review"
    });
    card.supportedInterfaces[0]!.protocolVersion = "0.3";
    const fetcher = vi.fn(async () => Response.json(AgentCard.toJSON(card)));

    await expect(
      discoverAgent("https://agent.example/card", fetcher)
    ).rejects.toThrow("A2A 1.0");
  });

  it("rejects an oversized Agent Card before parsing it", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("x", {
          headers: { "Content-Length": String(64 * 1024 + 1) }
        })
    );

    await expect(
      discoverAgent("https://agent.example/card", fetcher)
    ).rejects.toThrow("too large");
  });

  it("sends bearer-authenticated streaming turns and preserves identity", async () => {
    const task = taskValue(TaskState.TASK_STATE_INPUT_REQUIRED);
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer token"
        );
        expect(new Headers(init?.headers).get("A2A-Version")).toBe("1.0");
        return sse("request-1", {
          payload: { $case: "task", value: task }
        });
      }
    );

    await expect(
      sendStreamingTask({
        endpoint: "https://agent.example/a2a",
        fetcher,
        message: {
          contextId: task.contextId,
          messageId: "message-1",
          text: "hello"
        },
        requestId: "request-1",
        token: "token"
      })
    ).resolves.toMatchObject({
      id: task.id,
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stops reconnecting when authorization is required", async () => {
    const task = taskValue(TaskState.TASK_STATE_AUTH_REQUIRED);
    const fetcher = vi.fn(async () =>
      sse("request-auth", { payload: { $case: "task", value: task } })
    );

    await expect(
      sendStreamingTask({
        endpoint: "https://agent.example/a2a",
        fetcher,
        message: {
          contextId: task.contextId,
          messageId: "message-auth",
          text: "hello"
        },
        requestId: "request-auth",
        token: "token"
      })
    ).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_AUTH_REQUIRED }
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("replays the exact initial request until a task snapshot is accepted", async () => {
    const task = taskValue(TaskState.TASK_STATE_INPUT_REQUIRED);
    const bodies: string[] = [];
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) throw new TypeError("connection reset");
        return sse("request-retry", {
          payload: { $case: "task", value: task }
        });
      }
    );

    await expect(
      sendStreamingTask({
        endpoint: "https://agent.example/a2a",
        fetcher,
        message: {
          contextId: task.contextId,
          messageId: "stable-message",
          text: "hello"
        },
        requestId: "request-retry",
        token: "token"
      })
    ).resolves.toMatchObject({ id: task.id });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("accepts a completed snapshot when a continuation is replayed", async () => {
    const inputRequired = taskValue(TaskState.TASK_STATE_INPUT_REQUIRED);
    const completed = taskValue(TaskState.TASK_STATE_COMPLETED);
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id: string;
          params: { message: { taskId?: string } };
        };
        expect(request.params.message.taskId).toBe(inputRequired.id);
        return sse(request.id, {
          payload: { $case: "task", value: completed }
        });
      }
    );

    await expect(
      sendStreamingTask({
        currentTask: inputRequired,
        endpoint: "https://agent.example/a2a",
        fetcher,
        message: {
          contextId: inputRequired.contextId,
          messageId: "continuation-message",
          taskId: inputRequired.id,
          text: "prioritize correctness"
        },
        requestId: "continuation-request",
        token: "token"
      })
    ).resolves.toMatchObject({
      id: inputRequired.id,
      status: { state: TaskState.TASK_STATE_COMPLETED }
    });
  });

  it("uses one GetTask fallback when terminal subscription loses its race", async () => {
    const working = taskValue(TaskState.TASK_STATE_WORKING);
    const completed = taskValue(TaskState.TASK_STATE_COMPLETED);
    const methods: string[] = [];
    const transitions: string[] = [];
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
        };
        methods.push(request.method);
        if (request.method === "SendStreamingMessage") {
          return sse(request.id, {
            payload: { $case: "task", value: structuredClone(working) }
          });
        }
        if (request.method === "SubscribeToTask") {
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: A2A_ERROR_CODE.UNSUPPORTED_OPERATION,
              message: "already terminal"
            }
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: Task.toJSON(completed)
        });
      }
    );

    const result = await sendStreamingTask({
      endpoint: "https://agent.example/a2a",
      fetcher,
      message: {
        contextId: working.contextId,
        messageId: "message-2",
        text: "hello"
      },
      onTransition: async ({ message }) => {
        transitions.push(message);
      },
      requestId: "request-2",
      token: "token"
    });

    expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(methods).toEqual([
      "SendStreamingMessage",
      "SubscribeToTask",
      "GetTask"
    ]);
    expect(transitions.at(-1)).toContain("GetTask fallback");
  });

  it("checks the task once after recoverable subscription retries are exhausted", async () => {
    const working = taskValue(TaskState.TASK_STATE_WORKING);
    const completed = taskValue(TaskState.TASK_STATE_COMPLETED);
    const methods: string[] = [];
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
        };
        methods.push(request.method);
        if (request.method === "SendStreamingMessage") {
          return sse(request.id, {
            payload: { $case: "task", value: structuredClone(working) }
          });
        }
        if (request.method === "SubscribeToTask") {
          throw new TypeError("connection reset");
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: Task.toJSON(completed)
        });
      }
    );

    await expect(
      sendStreamingTask({
        endpoint: "https://agent.example/a2a",
        fetcher,
        message: {
          contextId: working.contextId,
          messageId: "message-reconnect-exhaustion",
          text: "hello"
        },
        requestId: "request-reconnect-exhaustion",
        token: "token"
      })
    ).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_COMPLETED }
    });
    expect(methods).toEqual([
      "SendStreamingMessage",
      "SubscribeToTask",
      "SubscribeToTask",
      "SubscribeToTask",
      "GetTask"
    ]);
  });
});

function taskValue(state: TaskState): Task {
  return {
    id: "specialist-task",
    contextId: "specialist-context",
    status: {
      state,
      message: undefined,
      timestamp: "2026-09-24T00:00:00.000Z"
    },
    artifacts: [],
    history: [],
    metadata: {}
  };
}

function sse(id: string, response: StreamResponseValue): Response {
  return new Response(
    `data: ${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: StreamResponse.toJSON(response)
    })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
