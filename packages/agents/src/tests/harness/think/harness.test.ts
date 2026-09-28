import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  MessageView,
  ThinkHarnessObject
} from "../../capabilities/think-harness";

type Stub = DurableObjectStub<ThinkHarnessObject>;

function fresh(name = crypto.randomUUID()): Stub {
  return env.ThinkHarnessObject.getByName(name);
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 3_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function toolPart(messages: MessageView[], toolCallId: string) {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

describe("ThinkHarness", () => {
  it("answers a message and ends the turn", async () => {
    const stub = fresh();
    await stub.script({ text: "Hello there" });

    await stub.send("hi", "t1");
    const end = await stub.wait("t1");

    expect(end).toMatchObject({ status: "completed", text: "Hello there" });
    const messages = await stub.messages();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(await stub.chunks("t1")).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish"
    ]);
  });

  it("runs a tool call and gives the result back to the model", async () => {
    const stub = fresh();
    await stub.script(
      { calls: [{ id: "c1", name: "add", input: { a: 2, b: 3 } }] },
      { text: "It is 5" }
    );

    await stub.send("add 2 and 3", "t1");
    const end = await stub.wait("t1");

    expect(end).toMatchObject({ status: "completed", text: "It is 5" });
    expect(await stub.toolRuns("add")).toBe(1);
    expect(toolPart(await stub.messages(), "c1")).toMatchObject({
      state: "output-available",
      output: { sum: 5 }
    });
    // One assistant message holds both model steps.
    expect((await stub.messages()).map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect((await stub.prompts())[1]).toContain('"sum":5');
  });

  it("parks for approval and runs the tool once approved", async () => {
    const stub = fresh();
    await stub.script(
      { calls: [{ id: "c1", name: "deploy", input: { env: "prod" } }] },
      { text: "Deployed" }
    );

    await stub.send("deploy it", "t1");
    const parked = await until(
      () => stub.messages(),
      (messages) => toolPart(messages, "c1")?.state === "approval-requested"
    );
    expect(toolPart(parked, "c1")?.state).toBe("approval-requested");
    expect(await stub.chunks("t1")).toContain("tool-approval-request");
    expect((await stub.turn("t1"))?.status).toBe("running");
    expect(await stub.toolRuns("deploy")).toBeUndefined();

    expect(await stub.answer("c1", true)).toBe(true);
    const end = await stub.wait("t1");

    expect(end).toMatchObject({ status: "completed", text: "Deployed" });
    expect(await stub.toolRuns("deploy")).toBe(1);
    expect(toolPart(await stub.messages(), "c1")).toMatchObject({
      state: "output-available",
      output: { deployed: "prod" }
    });
  });

  it("tells the model when a tool call is denied", async () => {
    const stub = fresh();
    await stub.script(
      { calls: [{ id: "c1", name: "deploy", input: { env: "prod" } }] },
      { text: "Understood" }
    );

    await stub.send("deploy it", "t1");
    await until(
      () => stub.messages(),
      (messages) => toolPart(messages, "c1")?.state === "approval-requested"
    );
    await stub.answer("c1", false);
    const end = await stub.wait("t1");

    expect(end).toMatchObject({ status: "completed", text: "Understood" });
    expect(await stub.toolRuns("deploy")).toBeUndefined();
    expect(toolPart(await stub.messages(), "c1")?.state).toBe("output-denied");
    expect(await stub.chunks("t1")).toContain("tool-output-denied");
  });

  it("waits for a client tool result", async () => {
    const stub = fresh();
    await stub.script(
      { calls: [{ id: "c1", name: "pickColor", input: {} }] },
      { text: "Blue it is" }
    );

    await stub.send("pick a color", "t1");
    await until(
      () => stub.messages(),
      (messages) => toolPart(messages, "c1")?.state === "input-available"
    );
    expect(await stub.resolveTool("c1", "blue")).toBe(true);
    const end = await stub.wait("t1");

    expect(end).toMatchObject({ status: "completed", text: "Blue it is" });
    expect(toolPart(await stub.messages(), "c1")).toMatchObject({
      state: "output-available",
      output: "blue"
    });
  });

  it("turns a throwing tool into an error the model reads", async () => {
    const stub = fresh();
    await stub.script(
      { calls: [{ id: "c1", name: "fail", input: {} }] },
      { text: "The tool failed" }
    );

    await stub.send("try it", "t1");
    const end = await stub.wait("t1");

    expect(end).toMatchObject({ status: "completed", text: "The tool failed" });
    expect(toolPart(await stub.messages(), "c1")).toMatchObject({
      state: "output-error",
      errorText: "tool exploded"
    });
  });

  it("ends the turn with an error when the model fails", async () => {
    const stub = fresh();
    await stub.script({ error: "model unavailable" });

    await stub.send("hi", "t1");
    const end = await stub.wait("t1");

    expect(end.status).toBe("error");
    expect(end.error).toContain("model unavailable");
    expect(await stub.chunks("t1")).toContain("error");
  });

  it("runs the turns of one chat in order, one at a time", async () => {
    const stub = fresh();
    await stub.script({ text: "first answer" }, { text: "second answer" });

    await stub.send("one", "t1");
    await stub.send("two", "t2");
    await stub.wait("t2");

    expect((await stub.ends()).map((end) => end.turnId)).toEqual(["t1", "t2"]);
    const messages = await stub.messages();
    expect(
      messages.map((message) =>
        message.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
      )
    ).toEqual(["one", "first answer", "two", "second answer"]);
  });

  it("stops a running turn and moves on to the next one", async () => {
    const stub = fresh();
    await stub.holdTools();
    await stub.script(
      { calls: [{ id: "c1", name: "slow", input: {} }] },
      { text: "next turn answer" }
    );

    await stub.send("go slow", "t1");
    await stub.send("then this", "t2");
    await until(
      () => stub.toolRuns("slow"),
      (runs) => runs === 1
    );
    expect(await stub.stop("t1")).toBe(true);

    const stopped = await stub.wait("t1");
    expect(stopped.status).toBe("stopped");
    expect(toolPart(await stub.messages(), "c1")?.state).toBe("output-error");
    const next = await stub.wait("t2");
    expect(next).toMatchObject({
      status: "completed",
      text: "next turn answer"
    });
  });

  it("reports an interrupted tool instead of running it again", async () => {
    const name = crypto.randomUUID();
    const stub = fresh(name);
    await stub.holdTools();
    await stub.script({ calls: [{ id: "c1", name: "slow", input: {} }] });

    await stub.send("go slow", "t1");
    await until(
      () => stub.toolRuns("slow"),
      (runs) => runs === 1
    );
    await evictDurableObject(stub);

    const restarted = fresh(name);
    const end = await restarted.wait("t1");

    expect(end.status).toBe("completed");
    expect(await restarted.toolRuns("slow")).toBe(1);
    expect(toolPart(await restarted.messages(), "c1")).toMatchObject({
      state: "output-error",
      errorText: expect.stringContaining("interrupted")
    });
  });

  it("runs an interrupted tool again when it says that is safe", async () => {
    const name = crypto.randomUUID();
    const stub = fresh(name);
    await stub.holdTools();
    await stub.script({ calls: [{ id: "c1", name: "read", input: {} }] });

    await stub.send("read it", "t1");
    await until(
      () => stub.toolRuns("read"),
      (runs) => runs === 1
    );
    await evictDurableObject(stub);

    const restarted = fresh(name);
    const end = await restarted.wait("t1");

    expect(end.status).toBe("completed");
    expect(await restarted.toolRuns("read")).toBe(2);
    expect(toolPart(await restarted.messages(), "c1")).toMatchObject({
      state: "output-available",
      output: "read done"
    });
  });

  it("keeps a turn parked for approval across an eviction", async () => {
    const name = crypto.randomUUID();
    const stub = fresh(name);
    await stub.script({
      calls: [{ id: "c1", name: "deploy", input: { env: "prod" } }]
    });

    await stub.send("deploy it", "t1");
    await until(
      () => stub.messages(),
      (messages) => toolPart(messages, "c1")?.state === "approval-requested"
    );
    await evictDurableObject(stub);

    const restarted = fresh(name);
    expect(await restarted.answer("c1", true)).toBe(true);
    const end = await restarted.wait("t1");

    expect(end.status).toBe("completed");
    expect(await restarted.toolRuns("deploy")).toBe(1);
  });
});
