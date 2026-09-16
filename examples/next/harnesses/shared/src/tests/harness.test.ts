import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { HarnessTestObject } from "./worker";

function fresh(): DurableObjectStub<HarnessTestObject> {
  return env.HARNESS_TEST.getByName(crypto.randomUUID());
}

describe("shared Harness", () => {
  it("admits a prompt, drives the runtime and settles a result", async () => {
    const stub = fresh();
    const { receipt, result } = await stub.run("hello");
    expect(receipt.accepted).toBe(true);
    expect(receipt.state).toBe("queued");
    expect(result.status).toBe("completed");
    expect(result.stopReason.type).toBe("end_turn");
    expect(result.raw).toEqual({ echoed: "echo: hello" });
    expect(await stub.messages()).toEqual(["hello", "echo: hello"]);
    const status = await stub.status();
    expect(status.state).toBe("idle");
    expect(status.queuedOperations).toBe(0);
    expect(status.capabilities).toContain("requests");
  });

  it("replays the durable log in seq order from any cursor", async () => {
    const stub = fresh();
    const first = await stub.run("one");
    await stub.run("two");
    const all = await stub.eventTypes();
    expect(all).toEqual([
      "session_opened",
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled",
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ]);
    const tail = await stub.eventTypes(first.result.cursor);
    expect(tail).toEqual([
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ]);
  });

  it("tails live events and previews", async () => {
    const stub = fresh();
    expect(await stub.tailEvents("live")).toEqual([
      "session_opened",
      "operation_started",
      "message_start",
      "preview:text_delta:echo: live",
      "message_end",
      "operation_settled"
    ]);
  });

  it("dedupes an operation id and rejects conflicting input", async () => {
    const stub = fresh();
    const first = await stub.prompt("same", "op-1");
    const again = await stub.prompt("same", "op-1");
    expect(first.accepted).toBe(true);
    expect(again.accepted).toBe(false);
    const conflict = await stub.prompt("different", "op-1").then(
      () => undefined,
      (error: unknown) => String(error)
    );
    expect(conflict).toMatch(/already admitted/);
    expect((await stub.wait("op-1")).status).toBe("completed");
  });

  it("queues prompts in order and drains them on interrupt", async () => {
    const stub = fresh();
    const slow = await stub.prompt("slow");
    const queued = await stub.prompt("queued behind");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await stub.status()).state).toBe("running");
    const interrupted = await stub.interrupt();
    expect(interrupted.operationId).toBe(slow.operationId);
    expect(interrupted.drained).toEqual([queued.operationId]);
    const result = await stub.wait(slow.operationId);
    expect(result.status).toBe("aborted");
    expect(result.stopReason.type).toBe("interrupted");
    expect((await stub.wait(queued.operationId)).status).toBe("declined");
    expect((await stub.status()).state).toBe("idle");
  });

  it("raises a request, blocks, and continues on reply", async () => {
    const stub = fresh();
    const receipt = await stub.prompt("ask me");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await stub.status();
    expect(status.state).toBe("blocked");
    const [request] = await stub.requests();
    expect(request?.type).toBe("permission");
    expect(status.pendingRequests).toEqual([request?.requestId]);
    const replied = await stub.reply(request!.requestId, "allow");
    expect(replied.accepted).toBe(true);
    expect(await stub.reply(request!.requestId, "allow")).toEqual({
      accepted: false
    });
    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("completed");
    const types = await stub.eventTypes();
    expect(types).toContain("request_raised");
    expect(types).toContain("request_replied");
    expect(types).toContain("extension:echo_permission");
  });

  it("times out an unanswered request with a deny", async () => {
    const stub = fresh();
    const receipt = await stub.prompt("ask and wait");
    const result = await stub.wait(receipt.operationId);
    expect(result.status).toBe("completed");
    expect(await stub.requests()).toEqual([]);
    expect(await stub.eventTypes()).toContain("request_replied");
  });

  it("accepts runtime submissions through submit()", async () => {
    const stub = fresh();
    const result = await stub.note("remember this");
    expect(result.status).toBe("completed");
    expect(await stub.messages()).toEqual(["remember this"]);
  });

  it("keeps sessions apart and lists them", async () => {
    const stub = fresh();
    await stub.run("a", "alpha");
    await stub.run("b", "beta");
    expect(await stub.messages("alpha")).toEqual(["a", "echo: a"]);
    expect(await stub.messages("beta")).toEqual(["b", "echo: b"]);
    const page = await stub.listSessions();
    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      "alpha",
      "beta"
    ]);
    await stub.deleteSession("alpha");
    expect(
      (await stub.listSessions()).sessions.map((session) => session.sessionId)
    ).toEqual(["beta"]);
    expect(await stub.eventTypes(undefined, "alpha")).toEqual([]);
  });

  it("survives eviction between operations", async () => {
    const stub = fresh();
    const first = await stub.run("before");
    await evictDurableObject(stub);
    expect(await stub.messages()).toEqual(["before", "echo: before"]);
    const second = await stub.run("after");
    expect(second.result.status).toBe("completed");
    const types = await stub.eventTypes(first.result.cursor);
    expect(types).toEqual([
      "operation_started",
      "message_start",
      "message_end",
      "operation_settled"
    ]);
  });

  it("resumes an operation that was running when the object was evicted", async () => {
    const stub = fresh();
    const operationId = await stub.startSlow("resume");
    await evictDurableObject(stub);
    const result = await stub.wait(operationId);
    expect(result.status).toBe("completed");
    expect(await stub.messages()).toEqual(["slow resume", "echo: slow resume"]);
    const types = await stub.eventTypes();
    expect(types.filter((type) => type === "operation_settled")).toHaveLength(
      1
    );
    expect((await stub.status()).state).toBe("idle");
    // A fresh isolate re-seeds the seq counter from the durable logs: the
    // frames it appends after the eviction must not reuse a number.
    const seqs = await stub.seqs();
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("pages sessions created in the same millisecond without skipping any", async () => {
    const stub = fresh();
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) await stub.run("x", id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await stub.listSessions(2, cursor);
      seen.push(...page.sessions.map((session) => session.sessionId));
      if (page.cursor === undefined) break;
      cursor = page.cursor;
    }
    expect(seen).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });
});
