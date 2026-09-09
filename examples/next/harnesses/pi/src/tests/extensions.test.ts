import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiExtensionsTestObject } from "./worker";

function fresh(): DurableObjectStub<PiExtensionsTestObject> {
  return env.PI_EXTENSIONS_TEST.getByName(crypto.randomUUID());
}

type ServerFrame = { readonly type: string } & Record<string, unknown>;

/** One client of the harness's WebSocket protocol, as a test drives it. */
type Client = {
  readonly send: (message: unknown) => void;
  /** Wait for the next frame of a type, from the ones already buffered on. */
  readonly next: (type: string) => Promise<ServerFrame>;
  readonly close: () => void;
};

/** Open a real WebSocket against one harness Durable Object. */
async function connect(
  stub: DurableObjectStub<PiExtensionsTestObject>
): Promise<Client> {
  const response = await stub.fetch("http://pi.test/?lane=main", {
    headers: { Upgrade: "websocket" }
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("The harness refused the WebSocket upgrade");
  socket.accept();

  const buffered: ServerFrame[] = [];
  const waiters: { type: string; resolve: (frame: ServerFrame) => void }[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as ServerFrame;
    const index = waiters.findIndex((waiter) => waiter.type === frame.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(frame);
      return;
    }
    buffered.push(frame);
  });

  return {
    send: (message) => socket.send(JSON.stringify(message)),
    next: (type) => {
      const index = buffered.findIndex((frame) => frame.type === type);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]!);
      return new Promise<ServerFrame>((resolve) => {
        waiters.push({ type, resolve });
      });
    },
    close: () => socket.close()
  };
}

describe("pi extension surface", () => {
  it("offers an extension tool to the model and runs it", async () => {
    const stub = fresh();
    expect(await stub.toolNames()).toContain("echo");

    const run = await stub.runEcho("hello");
    expect(run).toMatchObject({
      status: "completed",
      output: "echo:hello",
      toolError: false
    });
  });

  it("blocks a tool call from a tool_call handler", async () => {
    const stub = fresh();
    const allowed = await stub.runMultiply(4);
    expect(allowed).toMatchObject({
      status: "completed",
      output: "8",
      toolError: false
    });

    // A blocked call never executes, so pi settles it as an error tool
    // result carrying the handler's reason, with no tool_start/tool_end pair.
    const blocked = await stub.runMultiply(13);
    expect(blocked.status).toBe("completed");
    expect(blocked.output).toContain("unlucky");
    expect(blocked.toolError).toBe(true);

    const events = await stub.events(blocked.operationId);
    expect(events.some((event) => event.type === "tool_start")).toBe(false);
  });

  it("transforms the provider context without touching the transcript", async () => {
    const stub = fresh();
    await stub.runEcho("note");

    const seen = await stub.contextSeen();
    expect(seen.some((text) => text.includes("extension note"))).toBe(true);
    // The flag value the configuration seeded, not the registered default.
    expect(seen.some((text) => text.startsWith("flagged:"))).toBe(true);

    const messages = await stub.messages();
    expect(messages.some((text) => text.includes("extension note"))).toBe(
      false
    );
  });

  it("surfaces a throwing handler as handler_error and finishes the run", async () => {
    const stub = fresh();
    await stub.failMessageEnd(true);
    const run = await stub.runEcho("boom");
    await stub.failMessageEnd(false);

    expect(run.status).toBe("completed");
    const events = await stub.events(run.operationId);
    const errors = events.filter((event) => event.type === "handler_error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ message: "message_end handler failed" });
  });

  it("reloads its extensions after an eviction", async () => {
    const stub = fresh();
    expect((await stub.runMultiply(13)).output).toContain("unlucky");

    await evictDurableObject(stub);

    expect(await stub.toolNames()).toContain("echo");
    expect((await stub.runEcho("again")).output).toBe("echo:again");
    expect((await stub.runMultiply(13)).output).toContain("unlucky");
  });

  it("runs an extension slash command without opening an operation", async () => {
    const stub = fresh();
    const receipt = await stub.submitText("/note hello");
    expect(receipt).toEqual({
      accepted: false,
      command: "note",
      status: null
    });

    expect(await stub.customEntries()).toEqual([
      { customType: "test:note", text: "hello" }
    ]);
    // The command was not a prompt: nothing reached the model.
    expect(await stub.messages()).toEqual([]);
    expect(await stub.contextSeen()).toEqual([]);
  });

  it("expands a prompt template into a durable operation", async () => {
    const stub = fresh();
    const receipt = await stub.submitText("/greet world");
    expect(receipt).toMatchObject({ accepted: true, status: "completed" });

    const seen = await stub.contextSeen();
    expect(seen).toContain("Say hello to world");
  });

  it("answers a blocking extension dialog from a connected client", async () => {
    const stub = fresh();
    const client = await connect(stub);
    await client.next("snapshot");

    const run = stub.runEcho("pick one");
    const request = (await client.next(
      "extension_ui_request"
    )) as ServerFrame & {
      requestId: string;
      request: { method: string; options: readonly string[] };
    };
    expect(request.request.method).toBe("select");
    expect(request.request.options).toEqual(["a", "b"]);
    client.send({
      type: "extension_ui_response",
      requestId: request.requestId,
      response: { value: "b" }
    });

    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.output.endsWith(":b")).toBe(true);
    client.close();
  });

  it("answers a dialog with its default when nobody is listening", async () => {
    const stub = fresh();
    const run = await stub.runEcho("pick one");
    expect(run.status).toBe("completed");
    expect(run.output).toBe("echo:pick one:undefined");
  });

  it("sets an extension flag over the harness API", async () => {
    const stub = fresh();
    expect(await stub.setFlag("note-prefix", "changed")).toMatchObject({
      "note-prefix": "changed"
    });

    await stub.runEcho("after");
    const seen = await stub.contextSeen();
    expect(seen.at(-1)).toBe("changed: extension note");
  });

  it("lists extension, template and skill commands", async () => {
    const stub = fresh();
    const commands = await stub.commands();
    expect(commands).toEqual(
      expect.arrayContaining([
        { name: "note", description: expect.any(String), source: "extension" },
        { name: "greet", description: expect.any(String), source: "template" },
        { name: "tidy", description: expect.any(String), source: "skill" }
      ])
    );
    // Pi's terminal built-ins are not offered by a Durable Object.
    expect(commands.some((command) => command.name === "model")).toBe(false);
  });
});
