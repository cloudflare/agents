import {
  SendMessageRequest,
  Task,
  TaskState,
  type Artifact,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type StreamResponse
} from "@a2a-js/sdk";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError
} from "@a2a-js/sdk/errors";
import {
  agentMessage,
  conversationHistory,
  dataPart,
  messageFingerprint,
  SERVER_MESSAGE_ID_PREFIX,
  textArtifact
} from "../src/runtime/messages";
import { resolveA2AServerFeatures } from "../src/runtime/features";
import {
  DurableObjectTaskStore,
  MAX_SERIALIZED_TASK_BYTES,
  appendUniqueTaskMetadataItem,
  assertTaskFitsStorage,
  canApplyTurnCallback,
  messageIdBackfillRows,
  shouldRunSchemaMigration
} from "../src/runtime/task-store";
import { DurableA2ARequestHandler } from "../src/runtime/request-handler";
import type {
  A2ATaskRepository,
  AcceptedTask,
  CancellationTarget,
  DurableTaskEvent,
  EventWaiter,
  TaskReadOptions,
  TaskStreamSnapshot
} from "../src/runtime/task-store";
import type { WorkflowRunner } from "../src/runtime/executor";
import type { ResolvedA2AServerFeatures } from "../src/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { buildAgentCard } from "../src/agent-card";
import { createServerCallContext } from "../src/auth";

describe("durable A2A protocol", () => {
  it("keeps immediate send and polling available with core-only features", async () => {
    const { handler, runner, context } = setup(disabledFeatures());
    const accepted = taskValue(
      await handler.sendMessage(request("core-only", "hello"), context)
    );

    const loaded = await handler.getTask(
      {
        id: accepted.id,
        historyLength: 0,
        tenant: ""
      },
      context
    );

    expect(runner.started).toHaveLength(1);
    expect(loaded.id).toBe(accepted.id);
    expect(loaded.history).toEqual([]);
  });

  it("rejects blocking send before acceptance when it is not enabled", async () => {
    const { handler, runner, context } = setup(disabledFeatures());

    await expect(
      handler.sendMessage(
        request("blocking-disabled", "hello", "", false),
        context
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(runner.started).toHaveLength(0);
  });

  it("rejects streaming and listing when they are not enabled", async () => {
    const { handler, store, context } = setup(disabledFeatures());
    const stream = handler.sendMessageStream(
      request("streaming-disabled", "hello"),
      context
    );

    await expect(stream.next()).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
    await expect(
      handler.listTasks(
        {
          contextId: "context",
          historyLength: 0,
          includeArtifacts: false,
          pageSize: 50,
          pageToken: "",
          status: TaskState.TASK_STATE_UNSPECIFIED,
          statusTimestampAfter: "",
          tenant: ""
        },
        context
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(store.lastListParams).toBeUndefined();
  });

  it("rejects cancellation before termination when it is not enabled", async () => {
    const { handler, runner, context } = setup(disabledFeatures());
    const task = taskValue(
      await handler.sendMessage(request("cancel-disabled", "hello"), context)
    );

    await expect(
      handler.cancelTask(
        {
          id: task.id,
          metadata: {},
          tenant: ""
        },
        context
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(runner.terminated).toEqual([]);
  });

  it("rejects continuation before a second turn when it is not enabled", async () => {
    const { handler, runner, store, context } = setup(disabledFeatures());
    const task = taskValue(
      await handler.sendMessage(request("turn-disabled-1", "hello"), context)
    );
    store.requireInput(task.id, "Continue?");

    await expect(
      handler.sendMessage(request("turn-disabled-2", "yes", task.id), context)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(runner.started).toHaveLength(1);
  });

  it("streams artifact before completion and then terminates", async () => {
    const { handler, runner, store, context } = setup();
    const stream = handler.sendMessageStream(
      request("stream-1", "hello"),
      context
    );

    const snapshot = yielded(await stream.next());
    expect(snapshot.payload?.$case).toBe("task");
    expect(runner.started).toHaveLength(1);

    const taskId = taskValue(snapshot).id;
    const artifactPending = stream.next();
    await Promise.resolve();
    store.complete(taskId, "hello back");
    const artifact = yielded(await artifactPending);
    const completed = yielded(await stream.next());

    expect(artifact.payload?.$case).toBe("artifactUpdate");
    expect(completed.payload?.$case).toBe("statusUpdate");
    expect(statusState(completed)).toBe(TaskState.TASK_STATE_COMPLETED);
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(store.eventReadCalls).toBeGreaterThanOrEqual(2);
    expect(store.task(taskId).artifacts[0]).toMatchObject({
      artifactId: "response",
      name: "Response",
      parts: [{ mediaType: "text/plain" }]
    });
  });

  it("persists replacement intermediate artifacts in event order and wakes streams", async () => {
    const task = taskValueFrom("artifact");
    const { store, persistedTask, events } = publicationStore(task);
    const waiter = store.waitForUpdate(task.id);

    store.publishArtifactInternal(
      task.id,
      "progress-1",
      textArtifact("progress", "Progress", "Intermediate result.", "first"),
      1
    );
    await expect(waiter.promise).resolves.toBeUndefined();
    store.publishArtifactInternal(
      task.id,
      "progress-2",
      textArtifact("progress", "Progress", "Intermediate result.", "second"),
      1
    );

    expect(persistedTask().artifacts).toMatchObject([
      {
        artifactId: "progress",
        parts: [{ content: { value: "second" } }]
      }
    ]);
    expect(events.map((event) => event.payload?.$case)).toEqual([
      "artifactUpdate",
      "artifactUpdate"
    ]);
    expect(
      events.map((event) => {
        const payload = event.payload;
        return payload?.$case === "artifactUpdate"
          ? {
              artifactId: payload.value.artifact?.artifactId,
              text: payload.value.artifact?.parts[0]?.content?.value,
              append: payload.value.append,
              lastChunk: payload.value.lastChunk
            }
          : undefined;
      })
    ).toEqual([
      { artifactId: "progress", text: "first", append: false, lastChunk: true },
      { artifactId: "progress", text: "second", append: false, lastChunk: true }
    ]);
  });

  it("deduplicates artifact publication retries and rejects conflicting reuse", () => {
    const task = taskValueFrom("artifact-retry");
    const { store, persistedTask, events } = publicationStore(task);
    const first = textArtifact("progress", "Progress", "", "first");

    store.publishArtifactInternal(task.id, "stable-publication", first, 1);
    store.publishArtifactInternal(task.id, "stable-publication", first, 1);

    expect(events).toHaveLength(1);
    expect(() =>
      store.publishArtifactInternal(
        task.id,
        "stable-publication",
        textArtifact("progress", "Progress", "", "different"),
        1
      )
    ).toThrow("already used for different input");
    expect(events).toHaveLength(1);
    expect(persistedTask().artifacts[0]?.parts[0]?.content).toMatchObject({
      value: "first"
    });
  });

  it("throws for missing completion, failure, and input callback targets", () => {
    const { store, events } = publicationStore(taskValueFrom("existing"));

    expect(() => store.completeInternal("missing", "done", [], {}, 1)).toThrow(
      "Task missing was not found"
    );
    expect(() => store.failInternal("missing", "failed", 1)).toThrow(
      "Task missing was not found"
    );
    expect(() => store.requireInputInternal("missing", "Question?", 1)).toThrow(
      "Task missing was not found"
    );
    expect(events).toEqual([]);
  });

  it("rejects completion growth beyond the aggregate Task byte budget", () => {
    const task = taskValueFrom("oversized-completion");
    const { store, persistedTask, events } = publicationStore(task);

    expect(() =>
      store.completeInternal(
        task.id,
        "é".repeat(MAX_SERIALIZED_TASK_BYTES / 2),
        [],
        {},
        1
      )
    ).toThrow("UTF-8 storage budget");
    expect(persistedTask()).toEqual(task);
    expect(events).toEqual([]);
  });

  it("rejects artifact growth beyond the aggregate Task byte budget", () => {
    const task = taskValueFrom("oversized-artifact-growth");
    task.metadata = {
      padding: "x".repeat(MAX_SERIALIZED_TASK_BYTES - 200_000)
    };
    assertTaskFitsStorage(task);
    const { store, persistedTask, events } = publicationStore(task);

    expect(() =>
      store.publishArtifactInternal(
        task.id,
        "oversized-artifact-publication",
        textArtifact("growth", "Growth", "", "x".repeat(220 * 1024)),
        1
      )
    ).toThrow("UTF-8 storage budget");
    expect(persistedTask()).toEqual(task);
    expect(events).toEqual([]);
  });

  it("rejects metadata growth beyond the aggregate Task byte budget", () => {
    const task = taskValueFrom("oversized-metadata-growth");
    const { store, persistedTask, events } = publicationStore(task);

    expect(() =>
      store.appendMetadataItem(
        task.id,
        "items",
        "é".repeat(MAX_SERIALIZED_TASK_BYTES / 2),
        1
      )
    ).toThrow("UTF-8 storage budget");
    expect(persistedTask()).toEqual(task);
    expect(events).toEqual([]);
  });

  it("completes without inventing an artifact when none are supplied", () => {
    const task = taskValueFrom("message-only-completion");
    const { store, persistedTask, events } = publicationStore(task);

    store.completeInternal(task.id, "done", [], {}, 1);

    expect(persistedTask()).toMatchObject({
      artifacts: [],
      status: { state: TaskState.TASK_STATE_COMPLETED }
    });
    expect(events.map((event) => event.payload?.$case)).toEqual([
      "statusUpdate"
    ]);
  });

  it.each([
    ["undefined", undefined],
    [
      "undefined data",
      {
        ...textArtifact("invalid", "Invalid", "", "value"),
        parts: [dataPart(undefined)]
      }
    ],
    [
      "NaN data",
      {
        ...textArtifact("invalid", "Invalid", "", "value"),
        parts: [dataPart(Number.NaN)]
      }
    ],
    [
      "Date metadata",
      {
        ...textArtifact("invalid", "Invalid", "", "value"),
        metadata: { createdAt: new Date() }
      }
    ],
    [
      "malformed oneof",
      {
        ...textArtifact("invalid", "Invalid", "", "value"),
        parts: [
          {
            ...dataPart(null),
            content: { $case: "text", value: 42 }
          }
        ]
      }
    ]
  ])("rejects %s completion Artifacts without mutation", (_name, artifact) => {
    const harness = publicationStore(
      taskValueFrom(`invalid-completion-${_name}`)
    );

    expect(() =>
      harness.store.completeInternal(
        harness.persistedTask().id,
        "done",
        [artifact] as Artifact[],
        {},
        1
      )
    ).toThrow();
    expect(harness.persistedTask().status?.state).toBe(
      TaskState.TASK_STATE_WORKING
    );
    expect(harness.persistedTask().artifacts).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("persists an Artifact data:null without changing the oneof", () => {
    const task = taskValueFrom("null-artifact");
    const harness = publicationStore(task);
    const artifact: Artifact = {
      artifactId: "null-data",
      name: "Null data",
      description: "",
      parts: [dataPart(null)],
      metadata: {},
      extensions: []
    };

    harness.store.publishArtifactInternal(
      task.id,
      "null-publication",
      artifact,
      1
    );

    expect(harness.persistedTask().artifacts[0]?.parts[0]?.content).toEqual({
      $case: "data",
      value: null
    });
  });

  it("rejects invalid and stale completion callback turns without mutation", () => {
    const task = taskValueFrom("fenced-completion");
    const harness = publicationStore(task, 2);

    expect(() =>
      harness.store.completeInternal(task.id, "invalid", [], {}, 0)
    ).toThrow("positive safe integer");
    harness.store.completeInternal(task.id, "stale", [], {}, 1);

    expect(harness.persistedTask()).toEqual(task);
    expect(harness.events).toEqual([]);
  });

  it("promotes SUBMITTED before publishing and makes markWorking harmless", () => {
    const task = taskValueFrom("submitted");
    task.status = status(TaskState.TASK_STATE_SUBMITTED);
    const { store, persistedTask, events } = publicationStore(task);

    store.publishArtifactInternal(
      task.id,
      "submitted-progress",
      textArtifact("progress", "Progress", "", "value"),
      1
    );

    expect(persistedTask().status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(events.map((event) => event.payload?.$case)).toEqual([
      "statusUpdate",
      "artifactUpdate"
    ]);
    expect(statusState(events[0])).toBe(TaskState.TASK_STATE_WORKING);
    store.markWorking(task.id, 1);
    expect(events).toHaveLength(2);
  });

  it("rejects invalid intermediate artifact publications without mutation", () => {
    const artifact = textArtifact("progress", "Progress", "", "value");
    const stale = publicationStore(taskValueFrom("stale"), 1);

    expect(() =>
      stale.store.publishArtifactInternal(
        "stale",
        "stale-publication",
        artifact,
        2
      )
    ).toThrow("turn 2");
    expect(stale.persistedTask().artifacts).toEqual([]);
    expect(stale.events).toEqual([]);

    const nonWorkingTask = taskValueFrom("non-working");
    nonWorkingTask.status = status(TaskState.TASK_STATE_INPUT_REQUIRED);
    const nonWorking = publicationStore(nonWorkingTask);
    expect(() =>
      nonWorking.store.publishArtifactInternal(
        "non-working",
        "non-working-publication",
        artifact,
        1
      )
    ).toThrow("not SUBMITTED or WORKING");
    expect(nonWorking.persistedTask().artifacts).toEqual([]);
    expect(nonWorking.events).toEqual([]);
    expect(() =>
      stale.store.publishArtifactInternal(
        "missing",
        "missing-publication",
        artifact,
        1
      )
    ).toThrow("not found");
  });

  it.each([
    {
      name: "zero turn",
      turn: 0,
      artifact: textArtifact("valid", "", "", "value")
    },
    {
      name: "fractional turn",
      turn: 1.5,
      artifact: textArtifact("valid", "", "", "value")
    },
    {
      name: "unsafe turn",
      turn: Number.MAX_SAFE_INTEGER + 1,
      artifact: textArtifact("valid", "", "", "value")
    },
    {
      name: "blank artifactId",
      turn: 1,
      artifact: textArtifact("   ", "", "", "value")
    },
    {
      name: "empty parts",
      turn: 1,
      artifact: { ...textArtifact("valid", "", "", "value"), parts: [] }
    }
  ])("rejects $name before mutation", ({ turn, artifact }) => {
    const harness = publicationStore(taskValueFrom("invalid"));

    expect(() =>
      harness.store.publishArtifactInternal(
        "invalid",
        "invalid-publication",
        artifact,
        turn
      )
    ).toThrow();
    expect(harness.persistedTask().artifacts).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("accepts a 96 KiB artifact and rejects artifacts above 256 KiB", () => {
    const accepted = publicationStore(taskValueFrom("accepted-size"));
    accepted.store.publishArtifactInternal(
      "accepted-size",
      "accepted-size-publication",
      textArtifact("trace", "Trace", "", "x".repeat(96 * 1024)),
      1
    );
    expect(accepted.persistedTask().artifacts).toHaveLength(1);

    const rejected = publicationStore(taskValueFrom("rejected-size"));
    expect(() =>
      rejected.store.publishArtifactInternal(
        "rejected-size",
        "rejected-size-publication",
        textArtifact("trace", "Trace", "", "x".repeat(256 * 1024)),
        1
      )
    ).toThrow("exceeds 262144 bytes");
    expect(rejected.persistedTask().artifacts).toEqual([]);
    expect(rejected.events).toEqual([]);
  });

  it("caps intermediate artifact publications per task", () => {
    const harness = publicationStore(taskValueFrom("publication-limit"));
    const artifact = textArtifact("progress", "Progress", "", "value");
    for (let index = 0; index < 256; index++) {
      harness.store.publishArtifactInternal(
        "publication-limit",
        `publication-${index}`,
        artifact,
        1
      );
    }
    expect(harness.events).toHaveLength(256);

    expect(() =>
      harness.store.publishArtifactInternal(
        "publication-limit",
        "publication-over-limit",
        artifact,
        1
      )
    ).toThrow("publication limit");
    expect(harness.events).toHaveLength(256);
    expect(harness.persistedTask().artifacts).toHaveLength(1);
  });

  it("rejects resubscription to a terminal task", async () => {
    const { handler, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("terminal-1", "hello"), context)
    );
    store.complete(task.id, "done");

    const stream = handler.resubscribe({ id: task.id, tenant: "" }, context);
    await expect(stream.next()).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
  });

  it("does not start a second workflow for an initial retry", async () => {
    const { handler, runner, context } = setup();
    const params = request("retry-initial", "hello");
    const first = taskValue(await handler.sendMessage(params, context));
    const second = taskValue(await handler.sendMessage(params, context));

    expect(second.id).toBe(first.id);
    expect(runner.started).toHaveLength(1);
  });

  it("retries the same submitted workflow after an ambiguous launch error", async () => {
    const { handler, runner, context } = setup();
    runner.failStarts = 1;
    const params = request("retry-submitted", "hello");

    await expect(handler.sendMessage(params, context)).rejects.toThrow(
      "ambiguous launch"
    );
    const retried = taskValue(await handler.sendMessage(params, context));

    expect(runner.started).toHaveLength(2);
    expect(runner.started[1]?.id).toBe(runner.started[0]?.id);
    expect(retried.status?.state).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("waits for a stopping state when returnImmediately is false", async () => {
    const { handler, runner, store, context } = setup();
    const pending = handler.sendMessage(
      request("blocking", "hello", "", false),
      context
    );
    await vi.waitFor(() => expect(runner.started).toHaveLength(1));
    const taskId = runner.started[0]!.params.taskId;
    store.complete(taskId, "done");

    await expect(pending).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_COMPLETED }
    });
  });

  it("stops a blocking request when authorization is required", async () => {
    const { handler, runner, store, context } = setup();
    const pending = handler.sendMessage(
      request("blocking-auth", "hello", "", false),
      context
    );
    await vi.waitFor(() => expect(runner.started).toHaveLength(1));
    const taskId = runner.started[0]!.params.taskId;
    store.setState(taskId, TaskState.TASK_STATE_AUTH_REQUIRED);

    await expect(pending).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_AUTH_REQUIRED }
    });
  });

  it("omits list artifacts unless explicitly requested", async () => {
    const { handler, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("listed", "hello"), context)
    );
    store.complete(task.id, "done");
    const base = {
      contextId: "context",
      historyLength: 0,
      pageSize: 50,
      pageToken: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      statusTimestampAfter: "",
      tenant: ""
    };

    expect(
      (await handler.listTasks({ ...base, includeArtifacts: false }, context))
        .tasks[0]?.artifacts
    ).toEqual([]);
    expect(
      (await handler.listTasks({ ...base, includeArtifacts: true }, context))
        .tasks[0]?.artifacts
    ).toHaveLength(1);
  });

  it("pushes zero-history projections down to task storage", async () => {
    const { handler, store, context } = setup();
    const params = request("projected-send", "hello");
    if (!params.configuration) throw new Error("Expected send configuration.");
    params.configuration.historyLength = 0;
    const task = taskValue(await handler.sendMessage(params, context));

    expect(store.lastLoadOptions).toEqual({ historyLength: 0 });
    await handler.getTask(
      { id: task.id, historyLength: 0, tenant: "" },
      context
    );
    expect(store.lastLoadOptions).toEqual({ historyLength: 0 });
  });

  it("normalizes UTC list timestamps without mutating caller params", async () => {
    const { handler, store, context } = setup();
    const params: ListTasksRequest = {
      contextId: "context",
      historyLength: 0,
      includeArtifacts: false,
      pageSize: 50,
      pageToken: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      statusTimestampAfter: "2026-09-07T12:30:00Z",
      tenant: ""
    };

    await handler.listTasks(params, context);

    expect(params.statusTimestampAfter).toBe("2026-09-07T12:30:00Z");
    expect(store.lastListParams?.statusTimestampAfter).toBe(
      "2026-09-07T12:30:00.000Z"
    );
  });

  it("rejects timestamp offsets before querying storage", async () => {
    const { handler, store, context } = setup();

    await expect(
      handler.listTasks(
        {
          contextId: "context",
          historyLength: 0,
          includeArtifacts: false,
          pageSize: 50,
          pageToken: "",
          status: TaskState.TASK_STATE_UNSPECIFIED,
          statusTimestampAfter: "2026-09-07T08:30:00-04:00",
          tenant: ""
        },
        context
      )
    ).rejects.toThrow("ending in Z");
    expect(store.lastListParams).toBeUndefined();
  });

  it("rejects fractional list page sizes before querying storage", async () => {
    const { handler, store, context } = setup();

    await expect(
      handler.listTasks(
        {
          contextId: "context",
          historyLength: 0,
          includeArtifacts: false,
          pageSize: 1.5,
          pageToken: "",
          status: TaskState.TASK_STATE_UNSPECIFIED,
          statusTimestampAfter: "",
          tenant: ""
        },
        context
      )
    ).rejects.toThrow("integer between 1 and 100");
    expect(store.lastListParams).toBeUndefined();
  });

  it("streams the same task for an initial streaming retry", async () => {
    const { handler, runner, context } = setup();
    const params = request("retry-stream", "hello");
    const first = handler.sendMessageStream(params, context);
    const second = handler.sendMessageStream(params, context);

    const firstTask = taskValue(yielded(await first.next()));
    const secondTask = taskValue(yielded(await second.next()));

    expect(secondTask.id).toBe(firstTask.id);
    expect(runner.started).toHaveLength(1);
    await first.return();
    await second.return();
  });

  it("rejects a messageId reused with different input", async () => {
    const { handler, context } = setup();
    await handler.sendMessage(request("conflict", "first"), context);

    await expect(
      handler.sendMessage(request("conflict", "different"), context)
    ).rejects.toBeInstanceOf(RequestMalformedError);
  });

  it("fingerprints distinct equivalent Unicode keys independently of insertion", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    const left = request("unicode-keys", "hello").message!;
    const right = structuredClone(left);
    left.metadata = {
      [composed]: "composed",
      [decomposed]: "decomposed"
    };
    right.metadata = {
      [decomposed]: "decomposed",
      [composed]: "composed"
    };

    expect(messageFingerprint(left, "context", "")).toBe(
      messageFingerprint(right, "context", "")
    );
  });

  it("reserves server-generated message IDs from client input", async () => {
    const { handler, runner, context } = setup();
    const reservedId = `${SERVER_MESSAGE_ID_PREFIX}client-collision`;

    await expect(
      handler.sendMessage(request(reservedId, "hello"), context)
    ).rejects.toBeInstanceOf(RequestMalformedError);
    expect(runner.started).toEqual([]);
    expect(agentMessage("task", "context", "done").messageId).toMatch(
      new RegExp(`^${SERVER_MESSAGE_ID_PREFIX}`)
    );
  });

  it("continues INPUT_REQUIRED once and preserves conversation history", async () => {
    const { handler, runner, store, context } = setup();
    const first = taskValue(
      await handler.sendMessage(
        request("turn-1", "clarify: Which region?"),
        context
      )
    );
    store.requireInput(first.id, "Which region?");
    const followUp = request("turn-2", "Europe", first.id);

    const continued = taskValue(await handler.sendMessage(followUp, context));
    const retried = taskValue(await handler.sendMessage(followUp, context));

    expect(retried.id).toBe(first.id);
    expect(runner.started).toHaveLength(2);
    expect(runner.started[1]?.params).toMatchObject({
      taskId: first.id,
      turn: 2,
      prompt: "Europe"
    });
    expect(
      runner.started[1]?.params.conversation.map((item) => item.text)
    ).toEqual(["clarify: Which region?", "Which region?", "Europe"]);
    expect(continued.history.filter((item) => item.role === 1)).toHaveLength(2);
  });

  it("closes a live stream at INPUT_REQUIRED", async () => {
    const { handler, store, context } = setup();
    const stream = handler.sendMessageStream(
      request("input-stream", "hello"),
      context
    );
    const task = taskValue(yielded(await stream.next()));
    store.requireInput(task.id, "More detail?");

    expect(statusState(yielded(await stream.next()))).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("resubscribes to INPUT_REQUIRED with its snapshot and closes", async () => {
    const { handler, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("input-subscribe", "hello"), context)
    );
    store.requireInput(task.id, "More detail?");

    const stream = handler.resubscribe({ id: task.id, tenant: "" }, context);
    expect(taskValue(yielded(await stream.next())).status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects new follow-up input while a task is working", async () => {
    const { handler, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("working-1", "hello"), context)
    );

    await expect(
      handler.sendMessage(request("working-2", "too soon", task.id), context)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("rejects follow-up input after completion", async () => {
    const { handler, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("done-1", "hello"), context)
    );
    store.complete(task.id, "done");

    await expect(
      handler.sendMessage(request("done-2", "too late", task.id), context)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("cancels the active continuation workflow instance", async () => {
    const { handler, runner, store, context } = setup();
    const first = taskValue(
      await handler.sendMessage(request("cancel-1", "hello"), context)
    );
    store.requireInput(first.id, "Continue?");
    await handler.sendMessage(request("cancel-2", "yes", first.id), context);

    const canceled = await handler.cancelTask(
      { id: first.id, metadata: {}, tenant: "" },
      context
    );

    expect(runner.terminated).toEqual(["workflow-turn-2"]);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("supplies launch parameters when canceling a stranded SUBMITTED task", async () => {
    const { handler, runner, context } = setup();
    runner.failStarts = 1;
    await expect(
      handler.sendMessage(request("cancel-submitted", "hello"), context)
    ).rejects.toThrow("ambiguous launch");
    const launch = runner.started[0]!;

    const canceled = await handler.cancelTask(
      { id: launch.params.taskId, metadata: {}, tenant: "" },
      context
    );

    expect(runner.terminated).toEqual([launch.id]);
    expect(runner.terminationParams).toEqual([launch.params]);
    expect(runner.terminationAllowsMissing).toEqual([false]);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("blocks continuation while durable cancellation is pending", async () => {
    const { handler, runner, store, context } = setup();
    const first = taskValue(
      await handler.sendMessage(request("cancel-fence-1", "hello"), context)
    );
    store.requireInput(first.id, "Continue?");
    runner.afterTerminate = async () => {
      runner.afterTerminate = undefined;
      await expect(
        handler.sendMessage(request("cancel-fence-2", "yes", first.id), context)
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
    };

    const canceled = await handler.cancelTask(
      { id: first.id, metadata: {}, tenant: "" },
      context
    );

    expect(runner.terminated).toEqual([runner.started[0]!.id]);
    expect(runner.started).toHaveLength(1);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("does not relaunch an exact replay while cancellation is pending", async () => {
    const { handler, runner, context } = setup();
    const params = request("cancel-replay", "hello");
    const task = taskValue(await handler.sendMessage(params, context));
    runner.afterTerminate = async () => {
      runner.afterTerminate = undefined;
      const replay = taskValue(await handler.sendMessage(params, context));
      expect(replay.id).toBe(task.id);
    };

    const canceled = await handler.cancelTask(
      { id: task.id, metadata: {}, tenant: "" },
      context
    );

    expect(runner.started).toHaveLength(1);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("allows an expired INPUT_REQUIRED Workflow to be absent", async () => {
    const { handler, runner, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("cancel-expired", "hello"), context)
    );
    store.requireInput(task.id, "Continue?");

    const canceled = await handler.cancelTask(
      { id: task.id, metadata: {}, tenant: "" },
      context
    );

    expect(runner.terminationParams).toEqual([undefined]);
    expect(runner.terminationAllowsMissing).toEqual([true]);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("preserves completion when it wins during Workflow termination", async () => {
    const { handler, runner, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(
        request("cancel-terminal-race", "hello"),
        context
      )
    );
    runner.afterTerminate = async () => {
      runner.afterTerminate = undefined;
      store.complete(task.id, "done");
    };

    await expect(
      handler.cancelTask({ id: task.id, metadata: {}, tenant: "" }, context)
    ).rejects.toBeInstanceOf(TaskNotCancelableError);
    expect(store.task(task.id).status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED
    );
  });

  it("marks the parent canceled before a deferred cancellation hook settles", async () => {
    const { runner, store, context } = setup();
    let releaseHook: () => void = () => undefined;
    const hookStarted = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let observeHook: () => void = () => undefined;
    const enteredHook = new Promise<void>((resolve) => {
      observeHook = resolve;
    });
    const handler = new DurableA2ARequestHandler(
      testAgentCard(),
      store,
      runner,
      {
        features: enabledFeatures(),
        errors: {},
        cancellationHook: async () => {
          observeHook();
          await hookStarted;
        }
      }
    );
    const task = taskValue(
      await handler.sendMessage(request("cancel-race", "hello"), context)
    );
    const cancellation = handler.cancelTask(
      { id: task.id, metadata: {}, tenant: "" },
      context
    );
    await enteredHook;

    expect(store.task(task.id).status?.state).toBe(
      TaskState.TASK_STATE_CANCELED
    );
    expect(
      store.appendMetadataItem(task.id, "reviewChildren", { taskId: "late" }, 1)
    ).toMatchObject({ status: "canceled", task: { id: task.id } });

    releaseHook();
    await expect(cancellation).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
  });

  it("isolates cancellation hook mutation from acknowledgment and response", async () => {
    const { runner, store, context } = setup();
    const handler = new DurableA2ARequestHandler(
      testAgentCard(),
      store,
      runner,
      {
        features: enabledFeatures(),
        errors: {},
        cancellationHook: async (task) => {
          task.id = "mutated-id";
          task.status = status(TaskState.TASK_STATE_COMPLETED);
          task.history.length = 0;
        }
      }
    );
    const task = taskValue(
      await handler.sendMessage(request("cancel-mutation", "hello"), context)
    );

    const canceled = await handler.cancelTask(
      { id: task.id, metadata: {}, tenant: "" },
      context
    );

    expect(store.acknowledgedCancellationHooks).toEqual([task.id]);
    expect(canceled).toMatchObject({
      id: task.id,
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
    expect(canceled.history).toHaveLength(1);
    expect(store.task(task.id)).toMatchObject({
      id: task.id,
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
  });
});

describe("runtime persistence helpers", () => {
  it("runs schema migrations only when their version advances", () => {
    expect(shouldRunSchemaMigration(undefined, 1)).toBe(true);
    expect(shouldRunSchemaMigration(0, 1)).toBe(true);
    expect(shouldRunSchemaMigration(1, 1)).toBe(false);
    expect(shouldRunSchemaMigration(2, 1)).toBe(false);
  });

  it("backfills first and continuation user message fingerprints", () => {
    const first = request("first", "question").message;
    const second = request("second", "answer", "task-1").message;
    const task: Task = {
      id: "task-1",
      contextId: "context",
      status: status(TaskState.TASK_STATE_COMPLETED),
      artifacts: [],
      history: [first!, agentMessage("task-1", "context", "clarify"), second!],
      metadata: {}
    };
    const rows = messageIdBackfillRows(task, 123);

    expect(
      rows.map(({ messageId, taskId, acceptedAt }) => ({
        messageId,
        taskId,
        acceptedAt
      }))
    ).toEqual([
      { messageId: "first", taskId: "task-1", acceptedAt: 123 },
      { messageId: "second", taskId: "task-1", acceptedAt: 123 }
    ]);
    expect(rows[0]?.fingerprint).not.toBe(rows[1]?.fingerprint);
  });

  it("builds a deduplicated metadata array for atomic store updates", () => {
    const task = taskValueFrom("metadata");
    const child = {
      specialistId: "security",
      endpoint: "https://example/a2a",
      taskId: "child"
    };
    const second = {
      specialistId: "performance",
      endpoint: "https://example/a2a",
      taskId: "child-2"
    };
    expect(appendUniqueTaskMetadataItem(task, "reviewChildren", child)).toBe(
      true
    );
    expect(appendUniqueTaskMetadataItem(task, "reviewChildren", second)).toBe(
      true
    );
    expect(
      appendUniqueTaskMetadataItem(task, "reviewChildren", { ...child })
    ).toBe(false);
    expect(task.metadata?.reviewChildren).toEqual([child, second]);
  });

  it("deduplicates distinct equivalent Unicode keys independent of insertion", () => {
    const task = taskValueFrom("unicode-metadata");
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    const left = {
      [composed]: "composed",
      [decomposed]: "decomposed"
    };
    const right = {
      [decomposed]: "decomposed",
      [composed]: "composed"
    };

    expect(appendUniqueTaskMetadataItem(task, "items", left)).toBe(true);
    expect(appendUniqueTaskMetadataItem(task, "items", right)).toBe(false);
    expect(task.metadata?.items).toEqual([left]);
  });

  it("preserves null and rejects non-JSON metadata callback values", () => {
    const task = taskValueFrom("metadata-json-values");
    expect(appendUniqueTaskMetadataItem(task, "items", null)).toBe(true);
    expect(task.metadata?.items).toEqual([null]);
    expect(() =>
      appendUniqueTaskMetadataItem(task, "items", undefined)
    ).toThrow();
    expect(() =>
      appendUniqueTaskMetadataItem(task, "items", Number.NaN)
    ).toThrow();
    expect(() =>
      appendUniqueTaskMetadataItem(task, "items", new Date())
    ).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendUniqueTaskMetadataItem(task, "items", cyclic)).toThrow();

    const completion = publicationStore(
      taskValueFrom("completion-metadata-json")
    );
    expect(() =>
      completion.store.completeInternal(
        "completion-metadata-json",
        "done",
        [],
        { nested: { missing: undefined } },
        1
      )
    ).toThrow();
    expect(completion.persistedTask().status?.state).toBe(
      TaskState.TASK_STATE_WORKING
    );
  });

  it("rejects stale-turn metadata updates and protects INPUT_REQUIRED finality", async () => {
    const { handler, store, context } = setup();
    const task = taskValue(
      await handler.sendMessage(request("metadata-turn-1", "hello"), context)
    );
    store.requireInput(task.id, "Continue?");
    await handler.sendMessage(
      request("metadata-turn-2", "yes", task.id),
      context
    );

    expect(() =>
      store.appendMetadataItem(task.id, "reviewChildren", {}, 1)
    ).toThrow("stale turn");
    expect(
      canApplyTurnCallback(
        TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_COMPLETED
      )
    ).toBe(false);
    expect(
      canApplyTurnCallback(
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_COMPLETED
      )
    ).toBe(true);
  });

  it.each([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED
  ])("rejects metadata mutation in terminal state %s", (terminalState) => {
    const task = taskValueFrom(`terminal-metadata-${terminalState}`);
    task.status = status(terminalState);
    const { store, persistedTask } = publicationStore(task);

    if (terminalState === TaskState.TASK_STATE_CANCELED) {
      expect(store.appendMetadataItem(task.id, "items", {}, 1).status).toBe(
        "canceled"
      );
    } else {
      expect(() => store.appendMetadataItem(task.id, "items", {}, 1)).toThrow(
        "terminal"
      );
    }
    expect(persistedTask()).toEqual(task);
  });
});

class FakeRunner implements WorkflowRunner {
  readonly started: Array<{ id: string; params: AcceptedTask["params"] }> = [];
  readonly terminated: string[] = [];
  readonly terminationParams: Array<AcceptedTask["params"] | undefined> = [];
  readonly terminationAllowsMissing: boolean[] = [];
  afterTerminate?: () => Promise<void>;
  failStarts = 0;

  async start(id: string, params: AcceptedTask["params"]): Promise<void> {
    this.started.push({ id, params });
    if (this.failStarts-- > 0) throw new Error("ambiguous launch");
  }

  async terminate(
    instanceId: string,
    params?: AcceptedTask["params"],
    allowMissing = false
  ): Promise<void> {
    this.terminated.push(instanceId);
    this.terminationParams.push(params);
    this.terminationAllowsMissing.push(allowMissing);
    await this.afterTerminate?.();
  }
}

class FakeStore implements A2ATaskRepository {
  private readonly tasks = new Map<string, Task>();
  private readonly accepted = new Map<
    string,
    { fingerprint: string; taskId: string }
  >();
  private readonly active = new Map<string, string>();
  private readonly cancellations = new Map<string, CancellationTarget>();
  private readonly turns = new Map<string, number>();
  private readonly eventLog = new Map<string, DurableTaskEvent[]>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private sequence = 0;
  eventReadCalls = 0;
  readonly acknowledgedCancellationHooks: string[] = [];
  lastLoadOptions?: TaskReadOptions;
  lastListParams?: ListTasksRequest;

  async save(task: Task, _context: ServerCallContext): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async load(
    taskId: string,
    _context: ServerCallContext,
    options: TaskReadOptions = {}
  ): Promise<Task | undefined> {
    this.lastLoadOptions = options;
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  async list(
    params: ListTasksRequest,
    _context: ServerCallContext
  ): Promise<ListTasksResponse> {
    this.lastListParams = params;
    return {
      tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
      nextPageToken: "",
      pageSize: 50,
      totalSize: this.tasks.size
    };
  }

  async armRecovery(
    _delayMilliseconds?: number,
    _replace?: boolean
  ): Promise<void> {}

  acknowledgeCancellationHook(taskId: string): void {
    this.acknowledgedCancellationHooks.push(taskId);
  }

  pendingLaunches() {
    return [];
  }

  appendMetadataItem(taskId: string, key: string, item: unknown, turn: number) {
    const task = this.requiredTask(taskId);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      return { status: "canceled" as const, task: structuredClone(task) };
    }
    if (
      [
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_REJECTED
      ].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)
    ) {
      throw new Error(
        `Task ${taskId} is terminal and metadata cannot be changed.`
      );
    }
    if (this.turns.get(taskId) !== turn) throw new Error("stale turn");
    const appended = appendUniqueTaskMetadataItem(task, key, item);
    return {
      status: appended ? ("appended" as const) : ("duplicate" as const),
      task: structuredClone(task)
    };
  }

  acceptInitial(
    taskId: string,
    contextId: string,
    message: Message,
    fingerprint: string,
    _context: ServerCallContext
  ): AcceptedTask {
    const replay = this.replay(message.messageId, fingerprint);
    if (replay) return replay;
    const task: Task = {
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [message],
      metadata: { workflowInstanceId: taskId, turn: 1 }
    };
    this.tasks.set(taskId, task);
    this.accepted.set(message.messageId, { fingerprint, taskId });
    this.active.set(taskId, taskId);
    this.turns.set(taskId, 1);
    this.pushStatus(task);
    return this.result(task, true);
  }

  acceptContinuation(
    taskId: string,
    message: Message,
    fingerprint: string,
    _context: ServerCallContext
  ): AcceptedTask {
    const replay = this.replay(message.messageId, fingerprint);
    if (replay) return replay;
    const task = this.requiredTask(taskId);
    if (this.cancellations.has(taskId)) {
      throw new UnsupportedOperationError("Task is being canceled.");
    }
    if (task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
      throw new UnsupportedOperationError(
        "Task only accepts INPUT_REQUIRED follow-ups."
      );
    }
    const turn = (this.turns.get(taskId) ?? 1) + 1;
    task.history.push(message);
    task.status = status(TaskState.TASK_STATE_SUBMITTED);
    task.metadata = {
      ...(task.metadata ?? {}),
      workflowInstanceId: "workflow-turn-2",
      turn
    };
    this.accepted.set(message.messageId, { fingerprint, taskId });
    this.active.set(taskId, "workflow-turn-2");
    this.turns.set(taskId, turn);
    this.pushStatus(task);
    return this.result(task, true);
  }

  beginCancellation(taskId: string, _context: ServerCallContext) {
    const task = this.requiredTask(taskId);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      this.cancellations.delete(taskId);
      return { status: "canceled" as const, task: structuredClone(task) };
    }
    if ([3, 4, 5, 7].includes(task.status?.state ?? 0)) {
      this.cancellations.delete(taskId);
      throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
    }
    const existing = this.cancellations.get(taskId);
    if (existing) return { status: "pending" as const, target: existing };
    const target = {
      allowMissing: task.status?.state !== TaskState.TASK_STATE_SUBMITTED,
      taskId,
      workflowInstanceId: this.active.get(taskId) ?? taskId,
      turn: this.turns.get(taskId) ?? 1
    };
    const cancellationTarget =
      task.status?.state === TaskState.TASK_STATE_SUBMITTED
        ? { ...target, params: this.result(task, false).params }
        : target;
    this.cancellations.set(taskId, cancellationTarget);
    return { status: "pending" as const, target: cancellationTarget };
  }

  cancelAfterTermination(
    taskId: string,
    target: CancellationTarget,
    _context: ServerCallContext
  ) {
    const task = this.requiredTask(taskId);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      this.cancellations.delete(taskId);
      return {
        newlyCanceled: false,
        task: structuredClone(task)
      };
    }
    if ([3, 4, 5, 7].includes(task.status?.state ?? 0)) {
      this.cancellations.delete(taskId);
      throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
    }
    const intent = this.cancellations.get(taskId);
    if (
      !intent ||
      intent.workflowInstanceId !== target.workflowInstanceId ||
      intent.turn !== target.turn ||
      this.active.get(taskId) !== target.workflowInstanceId ||
      this.turns.get(taskId) !== target.turn
    )
      return undefined;
    task.status = status(TaskState.TASK_STATE_CANCELED);
    this.cancellations.delete(taskId);
    this.pushStatus(task);
    return { newlyCanceled: true, task: structuredClone(task) };
  }

  eventsAfter(taskId: string, sequence: number): DurableTaskEvent[] {
    this.eventReadCalls += 1;
    return (this.eventLog.get(taskId) ?? [])
      .filter((event) => event.sequence > sequence)
      .slice(0, 1);
  }

  markWorking(taskId: string, turn: number): void {
    if (this.turns.get(taskId) !== turn) return;
    if (this.cancellations.has(taskId)) return;
    const task = this.requiredTask(taskId);
    task.status = status(TaskState.TASK_STATE_WORKING);
    this.pushStatus(task);
  }

  async streamSnapshot(
    taskId: string,
    _context: ServerCallContext
  ): Promise<TaskStreamSnapshot> {
    return {
      task: structuredClone(this.requiredTask(taskId)),
      sequence: this.sequence
    };
  }

  waitForUpdate(taskId: string): EventWaiter {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const waiters = this.waiters.get(taskId) ?? new Set<() => void>();
    waiters.add(resolvePromise);
    this.waiters.set(taskId, waiters);
    return {
      promise,
      cancel: () => {
        waiters.delete(resolvePromise);
      }
    };
  }

  isInterruptedOrTerminal(taskId: string): boolean {
    const state = this.requiredTask(taskId).status?.state;
    return (
      state === TaskState.TASK_STATE_INPUT_REQUIRED ||
      state === TaskState.TASK_STATE_AUTH_REQUIRED ||
      [3, 4, 5, 7].includes(state ?? 0)
    );
  }

  task(taskId: string): Task {
    return structuredClone(this.requiredTask(taskId));
  }

  requireInput(taskId: string, question: string): void {
    const task = this.requiredTask(taskId);
    const message = agentMessage(
      task.id,
      task.contextId,
      question,
      "clarification.1"
    );
    task.history.push(message);
    task.status = {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message,
      timestamp: new Date().toISOString()
    };
    this.pushStatus(task);
  }

  setState(taskId: string, state: TaskState): void {
    const task = this.requiredTask(taskId);
    task.status = status(state);
    this.pushStatus(task);
  }

  complete(taskId: string, response: string): void {
    const task = this.requiredTask(taskId);
    const artifact = textArtifact(
      "response",
      "Response",
      "Generated response.",
      response
    );
    task.artifacts = [artifact];
    this.push(taskId, {
      payload: {
        $case: "artifactUpdate",
        value: {
          taskId,
          contextId: task.contextId,
          artifact,
          append: false,
          lastChunk: true,
          metadata: {}
        }
      }
    });
    task.status = status(TaskState.TASK_STATE_COMPLETED);
    this.cancellations.delete(taskId);
    this.pushStatus(task);
  }

  private replay(
    messageId: string,
    fingerprint: string
  ): AcceptedTask | undefined {
    const existing = this.accepted.get(messageId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprint) {
      throw new RequestMalformedError(
        "messageId was reused with different input."
      );
    }
    const task = this.requiredTask(existing.taskId);
    return this.result(
      task,
      task.status?.state === TaskState.TASK_STATE_SUBMITTED &&
        !this.cancellations.has(task.id)
    );
  }

  private result(task: Task, shouldStart: boolean): AcceptedTask {
    const turn = this.turns.get(task.id) ?? 1;
    const conversation = conversationHistory(task.history);
    const prompt =
      [...conversation].reverse().find((item) => item.role === "user")?.text ??
      "";
    return {
      task: structuredClone(task),
      shouldStart,
      workflowInstanceId: this.active.get(task.id) ?? task.id,
      params: {
        taskId: task.id,
        contextId: task.contextId,
        prompt,
        conversation,
        turn
      }
    };
  }

  private requiredTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    return task;
  }

  private pushStatus(task: Task): void {
    this.push(task.id, {
      payload: {
        $case: "statusUpdate",
        value: {
          taskId: task.id,
          contextId: task.contextId,
          status: structuredClone(task.status),
          metadata: {}
        }
      }
    });
  }

  private push(taskId: string, response: StreamResponse): void {
    const events = this.eventLog.get(taskId) ?? [];
    events.push({ sequence: ++this.sequence, response });
    this.eventLog.set(taskId, events);
    const waiters = this.waiters.get(taskId);
    this.waiters.delete(taskId);
    for (const wake of waiters ?? []) wake();
  }
}

function setup(features = enabledFeatures()): {
  context: ServerCallContext;
  handler: DurableA2ARequestHandler;
  runner: FakeRunner;
  store: FakeStore;
} {
  const context = createServerCallContext(
    new Request("https://agent.example/a2a", {
      headers: { "A2A-Version": "1.0" }
    })
  );
  const runner = new FakeRunner();
  const store = new FakeStore();
  const handler = new DurableA2ARequestHandler(testAgentCard(), store, runner, {
    features,
    errors: {}
  });
  return { context, handler, runner, store };
}

function enabledFeatures() {
  return resolveA2AServerFeatures({
    blockingSend: true,
    completionArtifacts: true,
    intermediateArtifacts: true,
    multiTurn: true,
    streaming: true,
    taskCancellation: true,
    taskListing: true
  });
}

function testAgentCard() {
  return buildAgentCard("https://agent.example", {
    description: "Protocol test agent.",
    name: "Protocol Test Agent",
    route: "coordinator",
    skillId: "protocol-test"
  });
}

function disabledFeatures(): ResolvedA2AServerFeatures {
  return resolveA2AServerFeatures();
}

function request(
  messageId: string,
  text: string,
  taskId = "",
  returnImmediately = true
): SendMessageRequest {
  return SendMessageRequest.fromJSON({
    message: {
      messageId,
      contextId: "context",
      taskId,
      role: "ROLE_USER",
      parts: [{ text }]
    },
    configuration: { returnImmediately }
  });
}

function taskValueFrom(id: string): Task {
  return {
    id,
    contextId: "context",
    status: status(TaskState.TASK_STATE_WORKING),
    artifacts: [],
    history: [],
    metadata: {}
  };
}

function publicationStore(
  task: Task,
  turn = 1
): {
  events: StreamResponse[];
  persistedTask(): Task;
  store: DurableObjectTaskStore;
} {
  let persisted = structuredClone(task);
  const row = {
    context_id: task.contextId,
    created_at: Date.now(),
    data: JSON.stringify(Task.toJSON(task)),
    id: task.id,
    normalized: 1,
    owner: "owner",
    state: task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
    turn,
    updated_at: Date.now(),
    workflow_instance_id: "workflow"
  };
  const events: StreamResponse[] = [];
  const publications = new Map<
    string,
    {
      fingerprint: string;
      publication_id: string;
      task_id: string;
      turn: number;
    }
  >();
  const store: DurableObjectTaskStore = Object.create(
    DurableObjectTaskStore.prototype
  );
  Object.defineProperties(store, {
    storage: {
      value: {
        transactionSync: (callback: () => void) => callback()
      }
    },
    waiters: { value: new Map<string, Set<() => void>>() },
    sql: {
      value: {
        exec: (query: string) => {
          throw new Error(`Unexpected SQL in publication harness: ${query}`);
        }
      }
    },
    taskRow: {
      value: (taskId: string) => (taskId === task.id ? row : undefined)
    },
    taskFromRow: {
      value: () => structuredClone(persisted)
    },
    updateTask: {
      value: (
        updatedTask: Task,
        workflowInstanceId: string,
        updatedTurn: number
      ) => {
        assertTaskFitsStorage(updatedTask);
        row.workflow_instance_id = workflowInstanceId;
        row.turn = updatedTurn;
        row.state =
          updatedTask.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        persisted = structuredClone(updatedTask);
      }
    },
    cancellationRow: { value: () => undefined },
    deleteCancellationIntent: { value: () => undefined },
    artifactPublication: {
      value: (taskId: string, publicationTurn: number, publicationId: string) =>
        publications.get(
          `${taskId}\u0000${publicationTurn}\u0000${publicationId}`
        )
    },
    registerArtifactPublication: {
      value: (
        publicationId: string,
        taskId: string,
        publicationTurn: number,
        fingerprint: string
      ) =>
        publications.set(
          `${taskId}\u0000${publicationTurn}\u0000${publicationId}`,
          {
            fingerprint,
            publication_id: publicationId,
            task_id: taskId,
            turn: publicationTurn
          }
        )
    },
    appendEvent: {
      value: (_taskId: string, event: StreamResponse) => events.push(event)
    },
    artifactEventCount: {
      value: () =>
        events.filter((event) => event.payload?.$case === "artifactUpdate")
          .length
    }
  });
  return { events, persistedTask: () => persisted, store };
}

function taskValue(value: unknown): Task {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected a task.");
  }
  if ("id" in value && typeof value.id === "string") return value as Task;
  if (
    "payload" in value &&
    typeof value.payload === "object" &&
    value.payload !== null &&
    "$case" in value.payload &&
    value.payload.$case === "task" &&
    "value" in value.payload
  ) {
    return value.payload.value as Task;
  }
  throw new Error("Expected a task payload.");
}

function statusState(value: StreamResponse | undefined): TaskState | undefined {
  return value?.payload?.$case === "statusUpdate"
    ? value.payload.value.status?.state
    : undefined;
}

function status(state: TaskState): Task["status"] {
  return { state, message: undefined, timestamp: new Date().toISOString() };
}

function yielded(result: IteratorResult<StreamResponse, void>): StreamResponse {
  if (result.done) throw new Error("Expected a stream event.");
  return result.value;
}
