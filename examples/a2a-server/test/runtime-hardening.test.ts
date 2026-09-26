import {
  ListTasksResponse,
  parseSseStream,
  SendMessageRequest,
  Task,
  type Artifact,
  type StreamResponse
} from "@a2a-js/sdk";
import { describe, expect, it, vi } from "vitest";
import { readBodyWithLimit } from "../src/runtime/body";
import { createJsonRpcSseResponse } from "../src/runtime/transport";
import { createA2AWorker } from "../src/runtime/worker";
import { WorkflowAgentExecutor } from "../src/runtime/executor";
import {
  deriveArtifactPublicationId,
  dataPart,
  textArtifact
} from "../src/runtime/messages";
import {
  MAX_JSON_RPC_REQUEST_ID_BYTES,
  assertJsonCompatible,
  parseLosslessJson,
  prepareA2ARequestForSdk,
  restoreMessageDataNull,
  validateA2AJsonRpcRequest,
  validateArtifactValue
} from "../src/runtime/json-validation";
import {
  assertWorkflowPayloadSize,
  DurableObjectTaskStore,
  serializedListResponseByteLength
} from "../src/runtime/task-store";
import type { A2AWorkflowParams } from "../src/runtime/types";
import {
  normalizeA2AWorkflowParams,
  validateA2ARuntimeOptions
} from "../src/runtime/types";

describe("runtime hardening", () => {
  it("does not persist stream events when durable events are disabled", () => {
    const exec = vi.fn();
    const store: object = Object.create(DurableObjectTaskStore.prototype);
    Object.defineProperties(store, {
      durableEvents: { value: false },
      sql: { value: { exec } }
    });

    (
      store as unknown as {
        appendEvent(taskId: string, event: StreamResponse): void;
      }
    ).appendEvent("task", { payload: undefined });

    expect(exec).not.toHaveBeenCalled();
  });

  it("cancels an oversized request body stream", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        canceled = true;
      }
    });
    const request = new Request("https://agent.example/a2a", {
      method: "POST",
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    await expect(readBodyWithLimit(request, 2)).rejects.toThrow("too large");
    expect(canceled).toBe(true);
  });

  it("rejects malformed UTF-8 instead of replacing bytes", async () => {
    const request = new Request("https://agent.example/a2a", {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28])
    });

    await expect(readBodyWithLimit(request, 100)).rejects.toThrow();
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>?]>([
    ["numeric text", { text: 12 }],
    ["string boolean", { text: "hello" }, { returnImmediately: "false" }],
    ["string integer", { text: "hello" }, { historyLength: "1" }]
  ])("rejects SDK-coercible %s input", (_name, part, configuration = {}) => {
    const value = requestEnvelope(part, configuration);
    expect(() => validateA2AJsonRpcRequest(value)).toThrow();
  });

  it("rejects multiple and duplicate Part payload fields", () => {
    expect(() =>
      validateA2AJsonRpcRequest(requestEnvelope({ text: "hello", data: null }))
    ).toThrow("exactly one");

    const duplicate = JSON.stringify(
      requestEnvelope({ text: "hello" })
    ).replace('"text":"hello"', '"text":"hello","text":"different"');
    expect(() => parseLosslessJson(duplicate)).toThrow("duplicate key text");
  });

  it.each([
    "1e400",
    "9007199254740993",
    "1e-400",
    "1.0000000000000001",
    "0.10000000000000001",
    "-0",
    "-0.0"
  ])("rejects an unrepresentable raw JSON number %s", (number) => {
    const body = JSON.stringify(requestEnvelope({ text: "hello" })).replace(
      '"configuration":{}',
      `"configuration":{"historyLength":${number}}`
    );
    expect(() => parseLosslessJson(body)).toThrow();
  });

  it.each([
    ["1.0", 1],
    ["1e0", 1],
    ["0.1", 0.1],
    ["1.2300e2", 123]
  ])("accepts a lossless equivalent JSON number %s", (token, expected) => {
    expect(parseLosslessJson(token)).toBe(expected);
  });

  it("canonicalizes every accepted request alias and removes snake_case", () => {
    const request = {
      jsonrpc: "2.0",
      id: "aliases",
      method: "SendMessage",
      params: {
        message: {
          message_id: "message",
          context_id: "context",
          task_id: "task",
          role: "ROLE_USER",
          parts: [{ text: "hello", media_type: "text/plain" }],
          reference_task_ids: ["reference"]
        },
        configuration: {
          accepted_output_modes: ["text/plain"],
          task_push_notification_config: { task_id: "" },
          history_length: 2,
          return_immediately: true
        }
      }
    } as Record<string, unknown>;

    validateA2AJsonRpcRequest(request);

    const serialized = JSON.stringify(request);
    expect(serialized).not.toMatch(/_[a-z]/);
    expect(request).toMatchObject({
      params: {
        message: {
          messageId: "message",
          contextId: "context",
          taskId: "task",
          parts: [{ mediaType: "text/plain" }],
          referenceTaskIds: ["reference"]
        },
        configuration: {
          acceptedOutputModes: ["text/plain"],
          taskPushNotificationConfig: { taskId: "" },
          historyLength: 2,
          returnImmediately: true
        }
      }
    });
  });

  it.each([
    ["GetTask", { id: "task", history_length: 1 }, ["historyLength"]],
    [
      "ListTasks",
      {
        context_id: "context",
        page_size: 10,
        page_token: "token",
        history_length: 1,
        status_timestamp_after: "2026-09-18T00:00:00Z",
        include_artifacts: true
      },
      [
        "contextId",
        "pageSize",
        "pageToken",
        "historyLength",
        "statusTimestampAfter",
        "includeArtifacts"
      ]
    ],
    [
      "ListTaskPushNotificationConfigs",
      {
        task_id: "task",
        page_size: 10,
        page_token: "token"
      },
      ["taskId", "pageSize", "pageToken"]
    ]
  ])("canonicalizes %s request aliases", (method, params, canonicalKeys) => {
    const request: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: "aliases",
      method,
      params
    };
    validateA2AJsonRpcRequest(request);

    for (const key of canonicalKeys as string[]) {
      expect(params).toHaveProperty(key);
    }
    expect(JSON.stringify(params)).not.toMatch(/_[a-z]/);
  });

  it("still rejects duplicate aliases", () => {
    const request = requestEnvelope({ text: "hello" });
    const params = request.params as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    message.message_id = message.messageId;

    expect(() => validateA2AJsonRpcRequest(request)).toThrow(
      "multiple aliases"
    );
  });

  it.each(["ROLE_OWNER", 3, -1, "UNRECOGNIZED"])(
    "rejects unsupported Role value %s",
    (role) => {
      const request = requestEnvelope({ text: "hello" });
      const params = request.params as Record<string, unknown>;
      (params.message as Record<string, unknown>).role = role;
      expect(() => validateA2AJsonRpcRequest(request)).toThrow(
        "supported Role"
      );
    }
  );

  it.each(["TASK_STATE_UNKNOWN", 9, -1, "UNRECOGNIZED"])(
    "rejects unsupported TaskState value %s",
    (status) => {
      expect(() =>
        validateA2AJsonRpcRequest({
          jsonrpc: "2.0",
          id: "state",
          method: "ListTasks",
          params: { contextId: "context", status }
        })
      ).toThrow("supported TaskState");
    }
  );

  it.each([
    ["missing", undefined],
    ["null", null],
    ["oversized", "x".repeat(MAX_JSON_RPC_REQUEST_ID_BYTES + 1)],
    ["oversized UTF-8", "é".repeat(MAX_JSON_RPC_REQUEST_ID_BYTES / 2 + 1)]
  ])("rejects a %s JSON-RPC request id", (_name, id) => {
    const request: Record<string, unknown> = {
      jsonrpc: "2.0",
      method: "GetExtendedAgentCard"
    };
    if (id !== undefined) request.id = id;

    expect(() => validateA2AJsonRpcRequest(request)).toThrow(/id/);
  });

  it("accepts a request id at the UTF-8 byte limit", () => {
    expect(() =>
      validateA2AJsonRpcRequest({
        jsonrpc: "2.0",
        id: "x".repeat(MAX_JSON_RPC_REQUEST_ID_BYTES),
        method: "GetExtendedAgentCard"
      })
    ).not.toThrow();
  });

  it.each([
    ["GetTask", { id: "task", historyLength: -1 }],
    ["ListTasks", { historyLength: -1 }],
    [
      "SendMessage",
      (
        requestEnvelope({ text: "hello" }, { historyLength: -1 }) as {
          params: Record<string, unknown>;
        }
      ).params
    ]
  ])("rejects negative historyLength for %s", (method, params) => {
    expect(() =>
      validateA2AJsonRpcRequest({
        jsonrpc: "2.0",
        id: "negative-history",
        method,
        params
      })
    ).toThrow("non-negative");
  });

  it.each([
    "",
    "2026-09-24 00:00:00Z",
    "2026-09-24T00:00:00+00:00",
    "2026-02-30T00:00:00Z",
    "2026-09-24T00:00:00z"
  ])("rejects non-canonical timestamp filter %j", (statusTimestampAfter) => {
    expect(() =>
      validateA2AJsonRpcRequest({
        jsonrpc: "2.0",
        id: "timestamp",
        method: "ListTasks",
        params: { statusTimestampAfter }
      })
    ).toThrow("timestamp");
  });

  it("rounds a valid nanosecond timestamp filter up to server precision", () => {
    const request = {
      jsonrpc: "2.0",
      id: "timestamp",
      method: "ListTasks",
      params: { statusTimestampAfter: "2026-09-24T00:00:00.123000001Z" }
    };

    validateA2AJsonRpcRequest(request);

    expect(request.params.statusTimestampAfter).toBe(
      "2026-09-24T00:00:00.124Z"
    );
  });

  it("tracks ListTasks bytes without repeatedly serializing prior tasks", () => {
    const task = Task.fromJSON({
      id: "task-é",
      contextId: "context",
      status: {
        state: "TASK_STATE_WORKING",
        timestamp: "2026-09-24T00:00:00.000Z"
      },
      history: [],
      artifacts: []
    });
    const response = {
      tasks: [task],
      nextPageToken: "next",
      pageSize: 50,
      totalSize: 1
    };
    const exactPayloadBytes = new TextEncoder().encode(
      JSON.stringify(ListTasksResponse.toJSON(response))
    ).byteLength;

    expect(
      serializedListResponseByteLength(
        response.tasks,
        response.nextPageToken,
        response.pageSize,
        response.totalSize
      )
    ).toBe(exactPayloadBytes + 4 * 1024);
  });

  it("preserves an explicit data:null through SDK oneof decoding", () => {
    const request = requestEnvelope({ data: null });
    validateA2AJsonRpcRequest(request);
    prepareA2ARequestForSdk(request);
    const params = SendMessageRequest.fromJSON(request.params);
    if (!params.message) throw new Error("Expected a message.");
    restoreMessageDataNull(params.message);

    expect(params.message.parts[0]?.content).toEqual({
      $case: "data",
      value: null
    });
  });

  it.each([
    "",
    "Zg",
    "Zg==",
    "Zm8",
    "Zm8=",
    "AQID",
    "+/8=",
    "+/8",
    "-_8=",
    "-_8"
  ])(
    "accepts canonical padded, unpadded, standard, or URL-safe base64 %j",
    (raw) => {
      expect(() =>
        validateA2AJsonRpcRequest(requestEnvelope({ raw }))
      ).not.toThrow();
    }
  );

  it.each(["Zg=", "AA=", "==", "Zh==", "A", "AAAA==", "+_8="])(
    "rejects malformed or non-canonical base64 %j",
    (raw) => {
      expect(() =>
        validateA2AJsonRpcRequest(requestEnvelope({ raw }))
      ).toThrow();
    }
  );

  it("recursively rejects non-JSON callback metadata while preserving null", () => {
    expect(() =>
      assertJsonCompatible({ nested: [null, { valid: true }] })
    ).not.toThrow();
    expect(() => assertJsonCompatible({ missing: undefined })).toThrow();
    expect(() =>
      assertJsonCompatible({ value: Number.POSITIVE_INFINITY })
    ).toThrow();
    expect(() => assertJsonCompatible(new Date())).toThrow("class instances");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonCompatible(cyclic)).toThrow("cycle");
  });

  it.each([
    ["undefined artifact", undefined],
    ["undefined data", structuredArtifact(undefined)],
    ["NaN data", structuredArtifact(Number.NaN)],
    ["Date data", structuredArtifact(new Date())],
    [
      "malformed oneof",
      {
        ...structuredArtifact(null),
        parts: [
          {
            ...dataPart(null),
            content: { $case: "text", value: 42 }
          }
        ]
      }
    ],
    [
      "class artifact",
      new (class ArtifactValue {
        artifactId = "class";
        name = "Class";
        description = "";
        parts = [dataPart(null)];
        metadata = {};
        extensions: string[] = [];
      })()
    ]
  ])("rejects an internal Artifact with %s", (_name, artifact) => {
    expect(() => validateArtifactValue(artifact)).toThrow();
  });

  it("preserves data:null in a strictly validated internal Artifact", () => {
    const artifact = structuredArtifact(null);
    expect(() => validateArtifactValue(artifact)).not.toThrow();
    expect(artifact.parts[0]?.content).toEqual({ $case: "data", value: null });
  });

  it("normalizes persisted first-turn Workflow payloads", () => {
    expect(
      normalizeA2AWorkflowParams({
        contextId: "context",
        prompt: "legacy prompt",
        taskId: "task"
      })
    ).toEqual({
      contextId: "context",
      prompt: "legacy prompt",
      taskId: "task",
      turn: 1,
      conversation: [{ role: "user", text: "legacy prompt" }]
    });
  });

  it("starts a tracked Agent Workflow with the stable instance ID", async () => {
    const runWorkflow = vi.fn(async () => undefined);
    const host = {
      getWorkflow: vi.fn(() => undefined),
      getWorkflowStatus: vi.fn(),
      runWorkflow,
      terminateWorkflow: vi.fn()
    };
    const params: A2AWorkflowParams = {
      contextId: "context",
      conversation: [{ role: "user", text: "hello" }],
      prompt: "hello",
      taskId: "task",
      turn: 1
    };

    await new WorkflowAgentExecutor(host).start("fixed", params);

    expect(runWorkflow).toHaveBeenCalledWith("fixed", params);
  });

  it("adopts a Workflow created before its Agent tracking insert", async () => {
    const failure = new Error("tracking insert interrupted");
    const adoptWorkflow = vi.fn(async () => true);
    const host = {
      adoptWorkflow,
      getWorkflow: vi.fn(() => undefined),
      getWorkflowStatus: vi.fn(),
      runWorkflow: vi.fn(async () => {
        throw failure;
      }),
      terminateWorkflow: vi.fn()
    };
    const params: A2AWorkflowParams = {
      contextId: "context",
      conversation: [{ role: "user", text: "hello" }],
      prompt: "hello",
      taskId: "task",
      turn: 1
    };

    await expect(
      new WorkflowAgentExecutor(host).start("fixed", params)
    ).resolves.toBeUndefined();
    expect(adoptWorkflow).toHaveBeenCalledWith("fixed");
  });

  it("materializes a submitted Workflow before terminating it", async () => {
    let tracked = false;
    const runWorkflow = vi.fn(async () => {
      tracked = true;
    });
    const terminateWorkflow = vi.fn(async () => undefined);
    const host = {
      getWorkflow: vi.fn(() => (tracked ? { status: "running" } : undefined)),
      getWorkflowStatus: vi.fn(async () => ({ status: "running" as const })),
      runWorkflow,
      terminateWorkflow
    };
    const params: A2AWorkflowParams = {
      contextId: "context",
      conversation: [{ role: "user", text: "hello" }],
      prompt: "hello",
      taskId: "task",
      turn: 1
    };

    await new WorkflowAgentExecutor(host).terminate("fixed", params);

    expect(runWorkflow).toHaveBeenCalledWith("fixed", params);
    expect(terminateWorkflow).toHaveBeenCalledWith("fixed");
  });

  it("derives a stable legacy publication ID from canonical artifact content", async () => {
    const base = textArtifact("progress", "Progress", "", "value");
    const left = { ...base, metadata: { beta: 2, alpha: 1 } };
    const right = { ...base, metadata: { alpha: 1, beta: 2 } };

    const [leftId, rightId] = await Promise.all([
      deriveArtifactPublicationId("task", left, 1),
      deriveArtifactPublicationId("task", right, 1)
    ]);
    expect(rightId).toBe(leftId);
  });

  it("rejects empty ownership and invalid numeric runtime configuration", () => {
    const valid = {
      agentBinding: "TEST_AGENT",
      agentCard: () => {
        throw new Error("not called");
      },
      bearerToken: () => "token",
      contextNamespace: () => {
        throw new Error("not called");
      },
      errors: {},
      ownerName: "owner",
      maxRequestBytes: 1024,
      unauthorizedResponse: () => new Response(null, { status: 401 }),
      workflowName: "TEST_WORKFLOW"
    } as Parameters<typeof validateA2ARuntimeOptions>[0];

    expect(() =>
      validateA2ARuntimeOptions({
        ...valid,
        ownerName: "   "
      })
    ).toThrow("ownerName must be a non-empty string");
    expect(() =>
      validateA2ARuntimeOptions({
        ...valid,
        maxRequestBytes: 0
      })
    ).toThrow("maxRequestBytes must be a positive safe integer");
    expect(() =>
      validateA2ARuntimeOptions({
        ...valid,
        terminalTaskRetentionMilliseconds: 0
      })
    ).toThrow(
      "terminalTaskRetentionMilliseconds must be a positive safe integer"
    );
    expect(() =>
      createA2AWorker({
        ...valid,
        ownerName: ""
      })
    ).toThrow("ownerName must be a non-empty string");
  });

  it.each(["complete", "errored"] as const)(
    "allows cancellation persistence when Workflow is %s",
    async (status) => {
      const terminateWorkflow = vi.fn();
      const host = {
        getWorkflow: vi.fn(() => ({ status })),
        getWorkflowStatus: vi.fn(async () => ({ status })),
        runWorkflow: vi.fn(),
        terminateWorkflow
      };

      await expect(
        new WorkflowAgentExecutor(host).terminate("task")
      ).resolves.toBeUndefined();
      expect(terminateWorkflow).not.toHaveBeenCalled();
    }
  );

  it("allows a retained Workflow instance to be absent when the task already stopped", async () => {
    const host = {
      getWorkflow: vi.fn(() => undefined),
      getWorkflowStatus: vi.fn(),
      runWorkflow: vi.fn(),
      terminateWorkflow: vi.fn()
    };

    await expect(
      new WorkflowAgentExecutor(host).terminate("expired", undefined, true)
    ).resolves.toBeUndefined();
  });

  it("does not hide transient Workflow status failures", async () => {
    const host = {
      getWorkflow: vi.fn(() => ({ status: "running" })),
      getWorkflowStatus: vi.fn(async () => {
        throw new Error("service unavailable");
      }),
      runWorkflow: vi.fn(),
      terminateWorkflow: vi.fn()
    };

    await expect(
      new WorkflowAgentExecutor(host).terminate("missing", undefined, true)
    ).rejects.toThrow("service unavailable");
  });

  it("recognizes a machine-readable missing code carried by Error", async () => {
    const host = {
      getWorkflow: vi.fn(() => ({ status: "running" })),
      getWorkflowStatus: vi.fn(async () => {
        throw Object.assign(new Error("Workflow lookup failed"), {
          code: 10400
        });
      }),
      runWorkflow: vi.fn(),
      terminateWorkflow: vi.fn()
    };

    await expect(
      new WorkflowAgentExecutor(host).terminate("expired", undefined, true)
    ).resolves.toBeUndefined();
  });

  it("reports an absent Workflow during terminal inspection", async () => {
    const host = {
      getWorkflow: vi.fn(() => ({ status: "running" })),
      getWorkflowStatus: vi.fn(async () => {
        throw Object.assign(new Error("Workflow lookup failed"), {
          code: 10400
        });
      }),
      runWorkflow: vi.fn(),
      terminateWorkflow: vi.fn()
    };

    await expect(
      new WorkflowAgentExecutor(host).inspect("expired")
    ).resolves.toEqual({ status: "missing" });
  });

  it("does not treat incidental not-found wording as an expired Workflow", async () => {
    const host = {
      getWorkflow: vi.fn(() => ({ status: "running" })),
      getWorkflowStatus: vi.fn(async () => {
        throw new Error("Workflow instance metadata was not found upstream");
      }),
      runWorkflow: vi.fn(),
      terminateWorkflow: vi.fn()
    };

    await expect(
      new WorkflowAgentExecutor(host).terminate("missing", undefined, true)
    ).rejects.toThrow("metadata was not found");
  });

  it("includes Agent metadata in the 1 MiB Workflow event limit", () => {
    const params: A2AWorkflowParams = {
      contextId: "context",
      conversation: [],
      prompt: "",
      taskId: "task",
      turn: 1
    };
    const identity = {
      agentBinding: "TEST_AGENT",
      agentName: "owner",
      workflowName: "TEST_WORKFLOW"
    };
    const fixedBytes = new TextEncoder().encode(
      JSON.stringify({
        ...params,
        __agentName: identity.agentName,
        __agentBinding: identity.agentBinding,
        __workflowName: identity.workflowName,
        __agentOrigin: {
          kind: "agent",
          version: 1,
          binding: identity.agentBinding,
          name: identity.agentName
        }
      })
    ).byteLength;
    params.prompt = "x".repeat(1024 * 1024 - fixedBytes);

    expect(() => assertWorkflowPayloadSize(params, identity)).not.toThrow();
    params.prompt += "x";
    expect(() => assertWorkflowPayloadSize(params, identity)).toThrow("1 MiB");
  });

  it.each(["terminated", "complete", "errored"] as const)(
    "reconciles a failed termination when Workflow becomes %s",
    async (status) => {
      const workflowStatus = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ status });
      const host = {
        getWorkflow: vi.fn(() => ({ status: "running" })),
        getWorkflowStatus: workflowStatus,
        runWorkflow: vi.fn(),
        terminateWorkflow: vi.fn(async () => {
          throw new Error("termination race");
        })
      };

      await expect(
        new WorkflowAgentExecutor(host).terminate("task")
      ).resolves.toBeUndefined();
      expect(workflowStatus).toHaveBeenCalledTimes(2);
    }
  );

  it("returns a JSON-RPC envelope when the first stream read fails", async () => {
    async function* failed(): AsyncGenerator<unknown, void, undefined> {
      yield await Promise.reject(new Error("pre-stream failure"));
    }
    const response = await createJsonRpcSseResponse(
      failed(),
      JSON.stringify({ jsonrpc: "2.0", id: "request-1" })
    );

    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "request-1",
      error: { code: -32603 }
    });
  });

  it("does not reflect an oversized request id in stream errors", async () => {
    async function* failed(): AsyncGenerator<unknown, void, undefined> {
      yield await Promise.reject(new Error("pre-stream failure"));
    }
    const response = await createJsonRpcSseResponse(
      failed(),
      JSON.stringify({
        jsonrpc: "2.0",
        id: "x".repeat(MAX_JSON_RPC_REQUEST_ID_BYTES + 1)
      })
    );

    await expect(response.json()).resolves.toMatchObject({ id: null });
  });

  it("keeps the request id in post-start SSE errors", async () => {
    async function* failed(): AsyncGenerator<unknown, void, undefined> {
      yield { jsonrpc: "2.0", id: "request-2", result: { task: {} } };
      throw new Error("stream failure");
    }
    const response = await createJsonRpcSseResponse(
      failed(),
      JSON.stringify({ jsonrpc: "2.0", id: "request-2" })
    );
    const events = [];
    for await (const event of parseSseStream(response)) events.push(event);

    expect(JSON.parse(events[1]!.data)).toMatchObject({
      jsonrpc: "2.0",
      id: "request-2",
      error: { code: -32603 }
    });
  });

  it("aborts and returns the iterator when an SSE reader cancels", async () => {
    let returned = false;
    const abortController = new AbortController();
    async function* values(): AsyncGenerator<unknown, void, undefined> {
      try {
        yield { jsonrpc: "2.0", id: "request-3", result: {} };
        await new Promise<void>((resolve) =>
          abortController.signal.addEventListener("abort", () => resolve(), {
            once: true
          })
        );
      } finally {
        returned = true;
      }
    }
    const response = await createJsonRpcSseResponse(
      values(),
      JSON.stringify({ jsonrpc: "2.0", id: "request-3" }),
      abortController
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("disconnect");

    expect(abortController.signal.aborted).toBe(true);
    expect(returned).toBe(true);
  });
});

function requestEnvelope(
  part: Record<string, unknown>,
  configuration: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "request",
    method: "SendMessage",
    params: {
      message: {
        messageId: "message",
        contextId: "context",
        role: "ROLE_USER",
        parts: [part]
      },
      configuration
    }
  };
}

function structuredArtifact(value: unknown): Artifact {
  return {
    artifactId: "structured",
    name: "Structured",
    description: "",
    parts: [dataPart(value)],
    metadata: {},
    extensions: []
  };
}
