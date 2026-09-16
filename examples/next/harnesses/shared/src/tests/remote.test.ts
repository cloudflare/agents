import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RemoteHarnessTestObject } from "./remote-worker";

function fresh(): DurableObjectStub<RemoteHarnessTestObject> {
  return env.REMOTE_HARNESS_TEST.getByName(crypto.randomUUID());
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `read` returns something, or give up loudly. */
async function until<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await wait(50);
  }
}

describe("ContainerHarnessRuntime over the daemon wire", () => {
  it("launches, delivers a prompt and settles from the daemon's frames", async () => {
    const stub = fresh();
    const { receipt, result } = await stub.run("hello");
    expect(receipt.accepted).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.stopReason.type).toBe("end_turn");
    expect(result.raw).toEqual({ echoed: "echo: hello" });
    expect(await stub.messages()).toEqual(["hello", "echo: hello"]);
    expect(await stub.eventTypes()).toEqual([
      "session_opened",
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ]);

    // Only the daemon's own frames carry a wire stamp, in wire order.
    const wired = (await stub.wireStamps()).filter((frame) => frame.wire);
    expect(wired.map((frame) => frame.type)).toEqual([
      "message_start",
      "message_end"
    ]);
    expect(wired.map((frame) => frame.wire?.seq)).toEqual([3, 4]);

    const container = await stub.containerInfo();
    expect(container.startCount).toBe(1);
    expect(container.env.CF_HARNESS_SESSION_ID).toBe("main");
    expect(container.env.CF_HARNESS_ENGINE).toBe("echo");
    expect(container.env.CF_HARNESS_ECHO_FLAVOUR).toBeUndefined();
    expect(container.env.ECHO_FLAVOUR).toBe("test");
    expect(container.env.CF_HARNESS_DOORBELL_URL).toBe(
      "https://example.test/_harness/doorbell?name=remote-test"
    );
  });

  it("parks on a permission request and continues on reply()", async () => {
    const stub = fresh();
    const receipt = await stub.prompt("ask me");
    const request = await until(
      async () => (await stub.requests())[0],
      "the permission request"
    );
    expect(request.type).toBe("permission");
    expect((await stub.status()).state).toBe("blocked");
    expect((await stub.reply(request.requestId, "allow")).accepted).toBe(true);

    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("completed");
    const types = await stub.eventTypes();
    expect(types).toContain("request_raised");
    expect(types).toContain("request_replied");
    expect(types).toContain("extension:echo_permission");
    expect(await stub.messages()).toEqual(["ask me", "echo: ask me"]);
    expect((await stub.status()).state).toBe("idle");
  });

  it("resumes from the wire cursor after the socket drops mid-operation", async () => {
    const stub = fresh();
    const receipt = await stub.prompt("slow work");
    await until(
      async () =>
        (await stub.status()).state === "running" ? true : undefined,
      "the operation to start"
    );
    await stub.dropSocket();
    // Frames the daemon produced while nobody was listening.
    await stub.finishParked(receipt.operationId);

    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("completed");
    expect(await stub.eventTypes()).toEqual([
      "session_opened",
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ]);
    const wired = (await stub.wireStamps()).filter((frame) => frame.wire);
    expect(wired.map((frame) => frame.wire?.seq)).toEqual([3, 4]);
    expect((await stub.daemonStats()).subscribes).toBeGreaterThanOrEqual(2);
  });

  it("settles a lost operation and runs the next one on the new generation", async () => {
    const stub = fresh();
    await stub.run("first");
    const before = (await stub.runtimeIds()).daemon;

    const doomed = await stub.prompt("slow and doomed");
    await until(
      async () =>
        (await stub.status()).state === "running" ? true : undefined,
      "the doomed operation to start"
    );
    await stub.crashContainer();

    const lost = await stub.wait(doomed.operationId);
    expect(lost.status).toBe("failed");
    expect(lost.stopReason.type).toBe("runtime_lost");

    const next = await stub.run("after the crash");
    expect(next.result.status).toBe("completed");
    const ids = await stub.runtimeIds();
    expect(ids.daemon).not.toBe(before);
    expect(ids.stored?.runtime_id).toBe(ids.daemon);
    // The new generation mints its own seqs from the start of its outbox.
    const wired = (await stub.wireStamps()).filter(
      (frame) => frame.wire?.runtimeId === ids.daemon
    );
    expect(wired.map((frame) => frame.wire?.seq)).toEqual([3, 4]);
  });

  it("takes an inbox row the daemon had already applied", async () => {
    const stub = fresh();
    await stub.preapply("op-redeliver", "hello");
    const { result } = await stub.run("hello", "op-redeliver");
    expect(result.status).toBe("completed");
    const stats = await stub.daemonStats();
    expect(stats.alreadyApplied).toBe(1);
    expect(stats.delivered).toBe(0);
    expect(await stub.messages()).toEqual(["hello", "echo: hello"]);
    expect((await stub.status()).state).toBe("idle");
  });

  it("rejects a doorbell without the secret and accepts one with it", async () => {
    const stub = fresh();
    await stub.run("hello");
    const secret = await stub.secret();
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect(await stub.ring(null)).toBe(401);
    expect(await stub.ring("00".repeat(16))).toBe(401);
    expect(await stub.ring(secret)).toBe(204);
  });

  it("keeps the operation running while the container's port is not up yet", async () => {
    const stub = fresh();
    // A cold container: the first dials are refused, then one answers.
    await stub.refuseDials(2);
    const receipt = await stub.prompt("hello");
    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("completed");
    expect((await stub.containerInfo()).failedDials).toBe(2);
    expect(await stub.eventTypes()).toEqual([
      "session_opened",
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ]);
  });

  it("drops frames for an operation it never admitted and keeps draining", async () => {
    const stub = fresh();
    await stub.run("first");
    await until(
      async () => ((await stub.info()).attached ? undefined : true),
      "the runtime to detach"
    );
    // Left in the outbox by a daemon the object had stopped listening to.
    await stub.strayOperation("op-ghost");
    const { result } = await stub.run("second");
    expect(result.status).toBe("completed");
    expect(await stub.messages()).toEqual([
      "first",
      "echo: first",
      "second",
      "echo: second"
    ]);
    const turn = [
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ];
    expect(await stub.eventTypes()).toEqual([
      "session_opened",
      ...turn,
      ...turn
    ]);
  });

  it("closes the socket when nothing is attached, leaving the container up", async () => {
    const stub = fresh();
    await stub.run("hello");
    await until(
      async () => ((await stub.info()).attached ? undefined : true),
      "the runtime to detach"
    );
    const info = await stub.info();
    expect(info.attached).toBe(false);
    expect(info.running).toBe(true);
    expect(info.runtimeId).not.toBe(null);
    const container = await stub.containerInfo();
    expect(container.inactivityTimeoutMs).toBe(60_000);
    expect(container.running).toBe(true);
  });

  it("adopts the running container after an eviction and resumes its cursor", async () => {
    const stub = fresh();
    await stub.run("before");
    await until(
      async () => ((await stub.info()).attached ? undefined : true),
      "the runtime to detach"
    );
    const before = await stub.runtimeIds();
    await evictDurableObject(stub);

    const { result } = await stub.run("after");
    expect(result.status).toBe("completed");
    const after = await stub.runtimeIds();
    expect(after.daemon).toBe(before.daemon);
    expect(after.stored?.runtime_id).toBe(before.daemon);
    expect((await stub.containerInfo()).startCount).toBe(1);
    expect(await stub.messages()).toEqual([
      "before",
      "echo: before",
      "after",
      "echo: after"
    ]);
    // The second generation of frames continues the same wire numbering.
    const wired = (await stub.wireStamps()).filter((frame) => frame.wire);
    expect(wired.map((frame) => frame.wire?.seq)).toEqual([3, 4, 9, 10]);
  });
});

describe("the engine's own transcript across container generations", () => {
  it("hands the engine its transcript back and resumes it on a new container", async () => {
    const stub = fresh();
    await stub.run("first");
    await stub.run("second");
    const before = await stub.engineState();
    expect(before.row?.engine_session_id).toBe("echo-session-0");
    expect(before.row?.restore_pending).toBe(0);

    await stub.crashContainer();
    const { result } = await stub.run("after the crash");
    expect(result.status).toBe("completed");

    const stats = await stub.daemonStats();
    // One restore, carrying every entry of the old engine session in order,
    // and naming it as the session the first turn must resume.
    const restores = stats.configures.filter(
      (record) => record.chunks.length > 0
    );
    expect(restores).toHaveLength(1);
    expect(restores[0]?.resume).toBe("echo-session-0");
    expect(stats.restored.find((entry) => entry.subpath === "")?.uuids).toEqual(
      [
        "echo-session-0:1:user",
        "echo-session-0:1:assistant",
        "echo-session-0:2:user",
        "echo-session-0:2:assistant"
      ]
    );
    expect(
      stats.restored.find((entry) => entry.subpath === "subagents/agent-1")
        ?.uuids
    ).toEqual(["echo-session-0:1:agent", "echo-session-0:2:agent"]);
    expect(stats.resumed).toBe(true);
    expect(stats.engineSessionId).toBe("echo-session-0");

    // The transcript continues on the same engine session, and nothing on the
    // log says the engine refused to resume.
    const after = await stub.engineState();
    expect(after.row?.engine_session_id).toBe("echo-session-0");
    expect(after.row?.restore_pending).toBe(0);
    expect(after.sessions).toBe(1);
    expect(await stub.eventTypes()).not.toContain("error");
    expect(await stub.messages()).toContain("echo: after the crash");
  });

  it("stores a re-mirrored batch once and restores each entry once", async () => {
    const stub = fresh();
    await stub.run("first");
    expect((await stub.engineState()).rows).toBe(2);

    // The engine re-sends the batch (an SDK mirror retry) and the transport
    // replays the frames under it (a socket drop mid-turn).
    await stub.remirror();
    await stub.dropSocket();
    await stub.run("second");
    // Two rows a turn plus the two the re-mirror arrived as; the replayed
    // frames are deduped by (runtime, wire seq) and add none.
    expect((await stub.engineState()).rows).toBe(6);

    await stub.crashContainer();
    await stub.run("third");
    const stats = await stub.daemonStats();
    expect(stats.restored.find((entry) => entry.subpath === "")?.uuids).toEqual(
      [
        "echo-session-0:1:user",
        "echo-session-0:1:assistant",
        "echo-session-0:2:user",
        "echo-session-0:2:assistant"
      ]
    );
  });

  it("splits a restore too big for one chunk and resumes once", async () => {
    const stub = fresh();
    await stub.run("bulk one");
    await stub.crashContainer();
    await stub.run("after the crash");

    const restores = (await stub.daemonStats()).configures.filter(
      (record) => record.chunks.length > 0
    );
    expect(restores).toHaveLength(1);
    const chunks = restores[0]?.chunks ?? [];
    // Two oversized main entries cannot share a chunk; the subagent's own
    // transcript is a chunk of its own whatever its size.
    expect(chunks.map((chunk) => chunk.subpath)).toEqual([
      null,
      null,
      "subagents/agent-1"
    ]);
    expect(chunks.map((chunk) => chunk.chunk)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.chunks)).toEqual([3, 3, 3]);
    expect(restores[0]?.resume).toBe("echo-session-0");
  });

  it("projects a tool result into the Sessions transcript", async () => {
    const stub = fresh();
    const { receipt, result } = await stub.run("tool please");
    expect(result.status).toBe("completed");
    const messages = await stub.sessionMessages();
    const tool = messages.find((message) => message.role === "tool");
    expect(tool?.id).toBe(`tool:call:${receipt.operationId}`);
    expect(tool?.parts).toEqual(["tool-result"]);
    // The assistant message is still its own row, in order.
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "tool",
      "assistant"
    ]);
  });

  it("says on the log when the engine would not resume what it was sent", async () => {
    const stub = fresh();
    await stub.run("first");
    await stub.refuseResume();
    await stub.crashContainer();

    // The turn still runs; only the model's memory of the first one is gone.
    const { result } = await stub.run("after the crash");
    expect(result.status).toBe("completed");

    const stats = await stub.daemonStats();
    expect(stats.resumed).toBe(false);
    expect(
      stats.configures.filter((record) => record.chunks.length > 0)
    ).toHaveLength(1);
    expect(await stub.eventTypes()).toContain("error");
    // Said once: the spent restore record keeps a reconnect from repeating it.
    const state = await stub.engineState();
    expect(state.row?.restore_runtime_id).toBe(null);
    expect(state.row?.restore_pending).toBe(0);
  });

  it("deletes the projected transcript with the session", async () => {
    const stub = fresh();
    await stub.run("first");
    expect((await stub.sessionMessages()).length).toBeGreaterThan(0);
    await stub.deleteSession();
    expect(await stub.sessionMessages()).toEqual([]);
    // A prompt after the delete starts a session with nothing behind it.
    const { result } = await stub.run("second");
    expect(result.status).toBe("completed");
    const roles = (await stub.sessionMessages()).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("reports the engine session on info()", async () => {
    const stub = fresh();
    const cold = await stub.info();
    expect(cold.engineSessionId).toBe(null);
    expect(cold.restorePending).toBe(false);

    await stub.run("hello");
    const warm = await stub.info();
    expect(warm.engineSessionId).toBe("echo-session-0");
    expect(warm.restorePending).toBe(false);
  });
});
