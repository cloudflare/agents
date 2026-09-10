import type {
  AgentHarnessToolInvocation,
  AgentLane,
  Entry,
  HarnessEvent,
  Hooks
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../../vendor/pi-coding-agent-src/core/extensions/runner.ts";
import { createExtensionActions } from "../harness/extensions/actions";
import {
  ExtensionEventAdapter,
  compactionEntry,
  messagesSince,
  runMessages
} from "../harness/extensions/events-adapter";
import { PiExtensionRuntime } from "../harness/extensions/runtime";
import { projectSessionEntry } from "../harness/extensions/session-view";
import { ExtensionLaneStates } from "../harness/extensions/state";
import { createExtensionModelRegistry } from "../harness/extensions/model-registry";
import { isDestructiveCommand } from "../extensions/notes";
import { createModels, resolveModel } from "../providers/models";
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

  it("blocks a tool call when the tool_call handler throws", async () => {
    const stub = fresh();
    // A gate that threw did not approve the call: pi's own beforeTool fails
    // closed, and so must the bridge, or a throwing permission check would
    // read as permission granted.
    const blocked = await stub.runMultiply(7);
    expect(blocked.toolError).toBe(true);
    expect(blocked.output).toContain("tool_call handler exploded");

    const events = await stub.events(blocked.operationId);
    expect(events.some((event) => event.type === "tool_start")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "handler_error" &&
          event.message === "tool_call handler exploded"
      )
    ).toBe(true);
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

  it("resolves a prompt that ran a command instead of an operation", async () => {
    const stub = fresh();
    // No operation was queued, so there is no result to wait for; waiting
    // for one anyway would never return.
    const response = await stub.promptText("/note quick");
    expect(response).toEqual({
      status: "completed",
      command: "note",
      handled: false
    });
    expect(await stub.customEntries()).toEqual([
      { customType: "test:note", text: "quick" }
    ]);
  });

  it("resolves a prompt an input handler consumed", async () => {
    const stub = fresh();
    const response = await stub.promptText("swallow this");
    expect(response).toEqual({
      status: "completed",
      command: null,
      handled: true
    });
    expect(await stub.messages()).toEqual([]);
  });

  it("runs input handlers once for a retried operation id", async () => {
    const stub = fresh();
    // The retry has to be refused before anything observable happens: an
    // `input` handler is a side effect, not a read.
    const outcome = await stub.submitTwice("say hello");
    expect(outcome).toEqual({ first: true, second: false, inputCalls: 1 });
  });

  it("queues one message when an action asks for a turn", async () => {
    const stub = fresh();
    await stub.promptText("/announce announce-token");

    // The custom message is queued for the next run; appending it as well
    // would leave two copies of it in the transcript.
    const queued = await stub.queued();
    expect(queued).toEqual([{ kind: "nextRun", role: null, text: null }]);

    await stub.runEcho("go");
    const seen = await stub.contextSeen();
    expect(seen.filter((text) => text.includes("announce-token"))).toEqual([]);
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

  it("refuses a dialog nobody is subscribed to answer", async () => {
    const stub = fresh();
    // Answering for an absent user is the dishonest option: `confirm` would
    // report a decline nobody made. The dialog throws instead, and the
    // failure says so.
    const run = await stub.runEcho("pick one");
    expect(run.status).toBe("completed");
    expect(run.toolError).toBe(true);
    expect(run.output).toContain("No client is connected");
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

  it("refuses a flag no extension registered, and a mistyped value", async () => {
    const stub = fresh();
    // The flag map is process-local state a client can write to, so an
    // unknown name must not grow it and a wrong type must not reach
    // `pi.getFlag`.
    expect(await stub.setFlagError("not-a-flag", "x")).toMatch(
      /No extension registered a flag named/
    );
    expect(await stub.setFlagError("note-prefix", true)).toMatch(
      /is a string flag/
    );
    expect(await stub.flags()).not.toHaveProperty("not-a-flag");
  });

  it("runs an extension tool on the lane whose run called it", async () => {
    const stub = fresh();
    // The tool body writes through the synchronous `pi.*` surface, which
    // resolves against whichever lane is current. A run on a second lane
    // must not leave its writes on the default one.
    const run = await stub.runEcho("mark-side", "side");
    expect(run).toMatchObject({ status: "completed", toolError: false });

    expect(await stub.customEntries("side")).toEqual([
      { customType: "test:tool-lane", text: "mark-side" }
    ]);
    expect(await stub.customEntries("main")).toEqual([]);
  });

  it("shows before_agent_start the configured system prompt on the first run", async () => {
    const stub = fresh();
    // `before_run` fires before the harness assembles the request, so the
    // lane's cached prompt is still empty on the first run of a session.
    await stub.runEcho("first");
    const seen = await stub.systemPromptsSeen();
    expect(seen[0]).toContain("Use the supplied test tools.");
    expect(seen[0]).not.toBe("");
  });

  it("reports the run's own messages to agent_end", async () => {
    const stub = fresh();
    await stub.runEcho("first");
    const first = await stub.agentEndTexts();
    expect(first).toHaveLength(1);
    // The run's own entries: its assistant turns and the tool result. The
    // prompt was recorded before the run opened, so it is not one of them.
    expect(first[0]?.join("\n")).toContain("echo:first");
    expect(first[0]?.join("\n")).toContain("echoed");

    // The second run reports only what it added, not the whole transcript.
    await stub.runEcho("second");
    const second = await stub.agentEndTexts();
    expect(second).toHaveLength(2);
    expect(second[1]?.join("\n")).toContain("echo:second");
    expect(second[1]?.join("\n")).not.toContain("echo:first");
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

  /**
   * A configured resource loader replaces the surface pi's extension runtime
   * reads, so its prompt templates have to reach the harness's own resources
   * as well. Left out, a template the loader serves is neither offered by
   * autocomplete nor resolvable when a client submits it.
   */
  it("lists and resolves a prompt template a resource loader serves", async () => {
    const stub = fresh();
    expect(await stub.commands()).toEqual(
      expect.arrayContaining([
        {
          name: "deploy",
          description: "Deploy to an environment.",
          source: "template"
        },
        // The configuration's own template is not displaced by the loader.
        { name: "greet", description: expect.any(String), source: "template" }
      ])
    );

    const receipt = await stub.submitText("/deploy staging");
    expect(receipt).toMatchObject({ accepted: true, status: "completed" });
    // The template was formatted and run as a prompt, not sent verbatim.
    expect(await stub.messages()).toContain("Deploy to staging");
  });
});

describe("process-local tool refresh", () => {
  /**
   * The tool registry is process-local and the lane's selection is durable.
   * A refresh that wrote the registry back on every drive pass would undo
   * `pi.setActiveTools([...])` between the command that called it and the
   * next turn — the extension narrows the set, the harness widens it again.
   */
  it("keeps an extension's tool selection across the next run", async () => {
    const stub = fresh();
    const before = await stub.activeTools();
    await stub.submitText("/only echo");
    const afterCommand = await stub.activeTools();
    const run = await stub.runEcho("hello");
    const afterRun = await stub.activeTools();

    expect(before).toEqual(["echo", "multiply"]);
    expect(afterCommand).toEqual(["echo"]);
    // The drive pass reconciled nothing: the registry did not change.
    expect(afterRun).toEqual(["echo"]);
    expect(run.status).toBe("completed");
  });

  /**
   * The baseline the reconciliation compares against has to outlive the
   * isolate. A deploy that registers a tool starts every isolate with an
   * empty memory, and a lane that already carries a selection would then be
   * read as never seen before — its selection left alone, and the new tool
   * inactive for the life of the session.
   */
  it("activates a newly deployed tool on a lane that already has a selection", async () => {
    const stub = fresh();
    // One pass against the registry as it stands, then a narrowing.
    expect((await stub.runEcho("first")).status).toBe("completed");
    await stub.submitText("/only echo");
    expect(await stub.activeTools()).toEqual(["echo"]);

    await stub.deployTool();
    await evictDurableObject(stub);

    // The first drive pass of the new isolate reconciles against the stored
    // baseline: the tool the deploy added joins, the narrowing stands.
    expect((await stub.runEcho("after deploy")).status).toBe("completed");
    expect(await stub.activeTools()).toEqual(["deployed", "echo"]);
  });
});

describe("extension cancellation", () => {
  /**
   * `ctx.signal` is the cancellation of the work the handler is running
   * inside. A tool that waits on it has to come back when the operation is
   * aborted, rather than waiting on a signal that never fires.
   */
  it("aborts a tool that is waiting on ctx.signal", async () => {
    const result = await fresh().runAbortedTool();

    expect(result.sawAbort).toBe(true);
    expect(result.status).not.toBe("completed");
  });
});

describe("extension notification lanes", () => {
  /**
   * Pi's `ExtensionContext` names no lane, so a notification handler's
   * `pi.*` calls land on whichever lane is current when it runs. Every
   * dispatched event therefore has to make its own lane current for the
   * length of its handlers, and hand the previous one back afterwards.
   */
  it("runs each notification on its own lane and restores the previous one", async () => {
    const states = new ExtensionLaneStates("main");
    const laneWhileEmitting: string[] = [];
    const refreshed: string[] = [];
    const runner = {
      emit: async () => {
        laneWhileEmitting.push(states.current.lane);
      },
      emitResourcesDiscover: async () => ({
        skillPaths: [],
        promptPaths: [],
        themePaths: []
      })
    } as unknown as ExtensionRunner;

    const adapter = new ExtensionEventAdapter(runner, {
      states,
      cwd: "/",
      resolveModel: () => undefined,
      report: () => {},
      refresh: async (lane) => {
        refreshed.push(lane);
      }
    });

    states.enter("main");
    adapter.dispatch({
      type: "run_start",
      lane: "side",
      runId: "run-1"
    } as unknown as HarnessEvent);
    await adapter.drain();

    expect(laneWhileEmitting).toEqual(["side"]);
    // The read model a handler reads is the one for the lane it fired on.
    expect(refreshed).toEqual(["side"]);
    // And the lane that was current before the notification still is.
    expect(states.current.lane).toBe("main");
  });
});

describe("extension lane scoping", () => {
  /**
   * Two lanes make progress at the same time and both await: a hook on one
   * can suspend on a blocking dialog while a handler on the other runs to
   * completion. A saved-and-restored current lane hands the suspended
   * handler the other lane when it resumes, so the scope has to travel with
   * the async context instead.
   */
  it("keeps a suspended handler on its own lane while another lane runs", async () => {
    const states = new ExtensionLaneStates("main");
    const written: string[] = [];
    const actions = createExtensionActions({
      states,
      lane: async (name) => {
        written.push(name);
        return {
          appendCustomEntry: async () => "entry"
        } as unknown as AgentLane;
      },
      setSessionName: async () => {},
      setLabel: async () => {},
      refreshTools: () => {},
      allTools: () => [],
      commands: () => [],
      report: () => {}
    });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = states.withLane("a", async () => {
      await gate;
      actions.appendEntry("test:a", { text: "a" });
      await states.get("a").drain();
    });
    const quick = states.withLane("b", async () => {
      actions.appendEntry("test:b", { text: "b" });
      await states.get("b").drain();
      release();
    });
    await Promise.all([quick, slow]);

    expect(written).toEqual(["b", "a"]);
    // And nothing leaked out of either scope.
    expect(states.current.lane).toBe("main");
  });
});

describe("run-scoped event payloads", () => {
  const entry = (id: string, text: string): Entry =>
    ({
      type: "message",
      id,
      parentId: null,
      seq: 0,
      timestamp: 0,
      message: { role: "user", content: text, timestamp: 0 }
    }) as Entry;

  it("slices agent_end messages from the tip the run started at", () => {
    const entries = [entry("1", "old"), entry("2", "new"), entry("3", "also")];
    expect(
      messagesSince(entries, { from: 1, tipId: "1" }).map((message) =>
        "content" in message ? message.content : ""
      )
    ).toEqual(["new", "also"]);
    // Nothing ran: no mark, no messages.
    expect(messagesSince(entries, undefined)).toEqual([]);
    // A run that started on an empty branch reports everything it added.
    expect(messagesSince(entries, { from: 0, tipId: null })).toHaveLength(3);
    // The tip was compacted away, so the recorded index is the only cursor.
    expect(messagesSince(entries, { from: 2, tipId: "gone" })).toHaveLength(1);
  });

  it("builds agent_end from the ids the run's own events carried", () => {
    const entries = [entry("1", "old"), entry("2", "new"), entry("3", "also")];
    const texts = (messages: ReturnType<typeof runMessages>) =>
      messages.map((message) => ("content" in message ? message.content : ""));

    // The mark landed after the run committed — the failure mode a fast
    // provider produces — and the ids still name what the run added.
    expect(
      texts(runMessages(entries, new Set(["2", "3"]), { from: 3, tipId: "3" }))
    ).toEqual(["new", "also"]);
    // Ids the branch no longer holds contribute nothing, rather than
    // shifting the window.
    expect(
      texts(runMessages(entries, new Set(["gone", "3"]), undefined))
    ).toEqual(["also"]);
    // No event carried an id, so the mark is the only cursor left.
    expect(
      texts(runMessages(entries, new Set(), { from: 1, tipId: "1" }))
    ).toEqual(["new", "also"]);
    expect(runMessages(entries, undefined, undefined)).toEqual([]);
  });

  it("projects the real compaction entry, or none at all", () => {
    const compaction = {
      type: "compaction",
      id: "c1",
      parentId: null,
      seq: 1,
      timestamp: 0,
      summary: "the story so far",
      retainedTail: [],
      tokensBefore: 4321,
      fromHook: false
    } as unknown as Entry;
    expect(
      compactionEntry([entry("1", "old"), compaction], "c1")
    ).toMatchObject({
      type: "compaction",
      summary: "the story so far",
      tokensBefore: 4321
    });
    // A summary and a token count nobody produced read to an extension
    // exactly like real ones, so an absent entry projects to nothing.
    expect(compactionEntry([entry("1", "old")], "c1")).toBeUndefined();
    expect(
      compactionEntry([entry("1", "old"), compaction], "c2")
    ).toBeUndefined();
  });

  /**
   * pi-agent-core records what a compaction kept as messages, not as a
   * cursor. Reporting the compaction's own id as `firstKeptEntryId` tells an
   * extension that nothing before it survived, so an extension paging back
   * from that cursor misses the very messages the model can still see.
   */
  it("derives a compaction's retained cursor from the branch", () => {
    const compaction = (id: string, retained: number): Entry =>
      ({
        type: "compaction",
        id,
        parentId: null,
        seq: 9,
        timestamp: 0,
        summary: "the story so far",
        retainedTail: Array.from({ length: retained }, () => ({
          role: "user",
          content: "kept",
          timestamp: 0
        })),
        tokensBefore: 10,
        fromHook: false
      }) as unknown as Entry;

    const branch = [
      entry("1", "first"),
      entry("2", "second"),
      entry("3", "third"),
      compaction("c1", 2)
    ];
    const projected = projectSessionEntry(branch[3]!, branch);
    expect(projected.type).toBe("compaction");
    // Two messages were kept, so the cursor is the earlier of the last two.
    expect(
      projected.type === "compaction" ? projected.firstKeptEntryId : null
    ).toBe("2");

    // A compaction that kept nothing genuinely starts at itself.
    const none = projectSessionEntry(compaction("c2", 0), branch);
    expect(none.type === "compaction" ? none.firstKeptEntryId : null).toBe(
      "c2"
    );

    // A tail longer than the branch keeps every message there is.
    const all = [entry("1", "first"), compaction("c3", 5)];
    const wide = projectSessionEntry(all[1]!, all);
    expect(wide.type === "compaction" ? wide.firstKeptEntryId : null).toBe("1");
  });
});

describe("extension write draining", () => {
  /**
   * Extension actions are synchronous to their caller and land on a per-lane
   * write chain, so a handler that returned has not necessarily written yet.
   * A caller reporting an outcome to a client has to wait for the chain, or
   * the client reads the transcript back before the writes arrive.
   */
  it("resolves drain only once the lane's queued writes have landed", async () => {
    const appended: string[] = [];
    const lane = {
      appendCustomEntry: async (customType: string) => {
        // A real durable write takes a task, not a microtask: a caller that
        // merely returned to the event loop has not waited for it.
        await new Promise((resolve) => setTimeout(resolve, 10));
        appended.push(customType);
        return "entry";
      },
      watch: async () => ({
        unsubscribe: () => {},
        snapshot: {
          transcript: [],
          tipId: null,
          configuration: { activeToolNames: [], thinkingLevel: "off" },
          operation: null,
          queues: []
        }
      }),
      getModel: async () => undefined
    } as unknown as AgentLane;

    const runtime = await PiExtensionRuntime.create({
      extensions: [
        (pi) => {
          pi.registerCommand("note", {
            description: "Append a note.",
            handler: async (args) => {
              pi.appendEntry("test:drain", { text: args });
            }
          });
        }
      ],
      cwd: "/",
      defaultLane: "main",
      sessionId: "session",
      models: createModels(),
      lane: async () => lane,
      setSessionName: async () => {},
      setLabel: async () => {},
      refreshTools: () => {},
      allTools: () => [],
      compact: async () => {},
      navigate: async () => {},
      report: () => {}
    });
    // Actions only exist once the runtime is attached to a live harness.
    runtime.attach({ on: () => () => {} } as unknown as Hooks);

    const ran = runtime.runCommand("main", "note", "hello");
    // The handler returns as soon as it has queued the write.
    await Promise.resolve();
    expect(appended).toEqual([]);

    // `runCommand` waits on `drain`, so a receipt means the write landed.
    expect(await ran).toBe(true);
    expect(appended).toEqual(["test:drain"]);

    // And an idle lane drains rather than hanging.
    await runtime.drain("main");
    expect(appended).toEqual(["test:drain"]);
    await runtime.stop();
  });

  /**
   * `pi.registerCommand` writes straight into the extension record, and pi's
   * extension API has no registration callback for commands. An extension
   * that registers one from a `session_start` handler does so after the
   * harness published the set this attachment offers, so without a report
   * from the record itself every connected client autocompletes a command
   * short for the rest of the session.
   */
  it("reports a command an extension registers after load", async () => {
    const published: string[][] = [];
    const runtime = await PiExtensionRuntime.create({
      extensions: [
        (pi) => {
          pi.registerCommand("note", {
            description: "Append a note.",
            handler: async () => {}
          });
          pi.on("session_start", () => {
            pi.registerCommand("late", {
              description: "Registered from session_start.",
              handler: async () => {}
            });
          });
        }
      ],
      cwd: "/",
      defaultLane: "main",
      sessionId: "session",
      models: createModels(),
      lane: async () => ({}) as unknown as AgentLane,
      setSessionName: async () => {},
      setLabel: async () => {},
      refreshTools: () => {},
      commandsChanged: () => {
        published.push(runtime.commands().map((command) => command.name));
      },
      allTools: () => [],
      compact: async () => {},
      navigate: async () => {},
      report: () => {}
    });
    // Nothing is reported for the registrations the load itself made: the
    // harness publishes that set once the attachment is complete.
    runtime.attach({ on: () => () => {} } as unknown as Hooks);
    expect(published).toEqual([]);

    await runtime.drain("main");
    // The debounce publishes on a microtask of its own.
    await Promise.resolve();
    expect(published.at(-1)).toContain("late");
    expect(published.at(-1)).toContain("note");
    await runtime.stop();
  });

  /**
   * The same hazard one layer up. A tool body writes through the same
   * synchronous surface a command handler does, and the harness settles the
   * tool call on the result the adapter returns: a result handed back ahead
   * of the write lets the operation complete, a client read the transcript,
   * and the isolate be evicted, with the write still queued.
   */
  it("returns an extension tool's result only once its writes have landed", async () => {
    const appended: string[] = [];
    const lane = {
      appendCustomEntry: async (customType: string) => {
        // A macrotask, as a durable write is: returning to the event loop is
        // not waiting for it.
        await new Promise((resolve) => setTimeout(resolve, 10));
        appended.push(customType);
        return "entry";
      },
      watch: async () => ({
        unsubscribe: () => {},
        snapshot: {
          transcript: [],
          tipId: null,
          configuration: { activeToolNames: [], thinkingLevel: "off" },
          operation: null,
          queues: []
        }
      }),
      getModel: async () => undefined
    } as unknown as AgentLane;

    const runtime = await PiExtensionRuntime.create({
      extensions: [
        (pi) => {
          pi.registerTool({
            name: "note",
            label: "Note",
            description: "Append a note and return.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => {
              pi.appendEntry("test:tool-drain", { text: params.text });
              return {
                content: [{ type: "text", text: `noted:${params.text}` }],
                details: undefined
              };
            }
          });
        }
      ],
      cwd: "/",
      defaultLane: "main",
      sessionId: "session",
      models: createModels(),
      lane: async () => lane,
      setSessionName: async () => {},
      setLabel: async () => {},
      refreshTools: () => {},
      allTools: () => [],
      compact: async () => {},
      navigate: async () => {},
      report: () => {}
    });
    runtime.attach({ on: () => () => {} } as unknown as Hooks);

    const tool = runtime.tools().find((candidate) => candidate.name === "note");
    expect(tool).toBeDefined();
    const result = await tool?.execute(
      "call-1",
      { text: "hello" },
      () => {},
      undefined,
      { turnId: "turn-1" } as unknown as AgentHarnessToolInvocation,
      BACKGROUND_CONTEXT
    );

    // The result is observable, so the write it queued must already be done.
    expect(appended).toEqual(["test:tool-drain"]);
    expect(result?.content).toEqual([{ type: "text", text: "noted:hello" }]);
    await runtime.stop();
  });
});

describe("extension provider registration", () => {
  /**
   * A provider an extension withdrew has to stop resolving models. The
   * configuration form is a process-local overlay the adapter owns, but the
   * native form reaches pi-ai's own registry, and an unregistration that
   * only dropped the overlay entry would leave the withdrawn provider fully
   * resolvable — the model an extension pulled because it stopped working
   * would still be selectable.
   */
  it("stops resolving a natively registered provider once it is unregistered", () => {
    const models = createModels();
    const registry = createExtensionModelRegistry(models);
    const faux = fauxProvider({ provider: "ext-native" });
    const modelId = faux.getModel().id;

    registry.registerProvider(faux.provider);
    expect(models.getModel("ext-native", modelId)).toBeDefined();

    registry.unregisterProvider("ext-native");
    expect(models.getModel("ext-native", modelId)).toBeUndefined();
    expect(() =>
      resolveModel(models, { provider: "ext-native", modelId })
    ).toThrow(/Unknown pi model/);
  });

  /**
   * Registering over an id the host configured shadows it; unregistering has
   * to put it back. Deleting it instead would take a provider the extension
   * surface never owned — and, when the lane's own model came from it, the
   * session's model with it.
   */
  it("restores a host provider an extension registered over", () => {
    const models = createModels();
    const host = fauxProvider({
      provider: "shared",
      models: [{ id: "host-model" }]
    });
    const extension = fauxProvider({
      provider: "shared",
      models: [{ id: "ext-model" }]
    });
    models.setProvider(host.provider);
    const registry = createExtensionModelRegistry(models);

    registry.registerProvider(extension.provider);
    expect(models.getModel("shared", "ext-model")).toBeDefined();
    expect(models.getModel("shared", "host-model")).toBeUndefined();

    registry.unregisterProvider("shared");
    expect(models.getModel("shared", "host-model")).toBeDefined();
    expect(models.getModel("shared", "ext-model")).toBeUndefined();
  });

  it("deletes an id no host provider stood under", () => {
    const models = createModels();
    const registry = createExtensionModelRegistry(models);
    const extension = fauxProvider({
      provider: "ext-only",
      models: [{ id: "ext-model" }]
    });

    registry.registerProvider(extension.provider);
    registry.unregisterProvider("ext-only");

    expect(models.getProvider("ext-only")).toBeUndefined();
  });

  it("lets either registration form replace the other under one name", () => {
    const models = createModels();
    const registry = createExtensionModelRegistry(models);
    const faux = fauxProvider({ provider: "ext-both" });
    const modelId = faux.getModel().id;

    registry.registerProvider(faux.provider);
    // The configuration form resolves no models of its own, so the pi-ai
    // provider it replaced must not keep answering for the name.
    registry.registerProvider("ext-both", { api: "openai-completions" });
    expect(models.getModel("ext-both", modelId)).toBeUndefined();
    expect(registry.registrations()).toEqual([
      { name: "ext-both", config: { api: "openai-completions" } }
    ]);

    // And back the other way: the native registration wins, and the overlay
    // entry it replaced is gone.
    registry.registerProvider(faux.provider);
    expect(models.getModel("ext-both", modelId)).toBeDefined();
    expect(registry.registrations()).toEqual([]);
  });

  /**
   * The configuration form takes the id as completely as the native one. A
   * host provider left resolvable under a name an extension had registered
   * over went on serving models from the provider the extension replaced —
   * silently, since the overlay resolves nothing of its own to disagree with.
   */
  it("displaces a host provider the configuration form registered over", () => {
    const models = createModels();
    const host = fauxProvider({
      provider: "shared",
      models: [{ id: "host-model" }]
    });
    models.setProvider(host.provider);
    const registry = createExtensionModelRegistry(models);

    registry.registerProvider("shared", { api: "openai-completions" });
    expect(models.getProvider("shared")).toBeUndefined();
    expect(models.getModel("shared", "host-model")).toBeUndefined();
    expect(registry.registrations()).toEqual([
      { name: "shared", config: { api: "openai-completions" } }
    ]);

    registry.unregisterProvider("shared");
    expect(models.getModel("shared", "host-model")).toBeDefined();
    expect(registry.registrations()).toEqual([]);
  });

  /**
   * The displaced host provider is held once, whichever form took the id and
   * whatever replaces it in between: only unregistering hands it back.
   */
  it("hands a displaced host provider back across a change of form", () => {
    const models = createModels();
    const host = fauxProvider({
      provider: "shared",
      models: [{ id: "host-model" }]
    });
    const extension = fauxProvider({
      provider: "shared",
      models: [{ id: "ext-model" }]
    });
    models.setProvider(host.provider);
    const registry = createExtensionModelRegistry(models);

    registry.registerProvider("shared", { api: "openai-completions" });
    registry.registerProvider(extension.provider);
    expect(models.getModel("shared", "ext-model")).toBeDefined();
    expect(models.getModel("shared", "host-model")).toBeUndefined();
    expect(registry.registrations()).toEqual([]);

    registry.registerProvider("shared", { api: "openai-completions" });
    expect(models.getProvider("shared")).toBeUndefined();

    registry.unregisterProvider("shared");
    expect(models.getModel("shared", "host-model")).toBeDefined();
    expect(models.getModel("shared", "ext-model")).toBeUndefined();
  });
});

/**
 * The gate in `src/extensions/notes.ts` is a demo of the confirmation dialog,
 * not a security boundary — the sandboxed `Workspace` is what makes a bash
 * command safe. It should still hold up against the shell writing the same
 * command a different way, which the literal `rm ` it started as did not.
 */
describe("destructive command gate", () => {
  it.each([
    "rm -rf /",
    "rm -rf /tmp/x",
    "ls; rm -rf x",
    "ls && rm -rf x",
    "find . | xargs rm",
    "echo hi\nrm -rf x",
    "sudo rm -rf /",
    "/bin/rm -rf /",
    'sh -c "rm -rf /"',
    "echo $(rm -rf x)",
    "cat a && truncate -s 0 b",
    "mv /a /b"
  ])("asks about %j", (command) => {
    expect(isDestructiveCommand(command)).toBe(true);
  });

  it.each([
    "echo rm",
    "echo 'rm -rf /'",
    "ls -la",
    "grep -r rm .",
    "cat rm.txt",
    "echo warm milk"
  ])("stays out of the way of %j", (command) => {
    expect(isDestructiveCommand(command)).toBe(false);
  });
});

describe("overlapping tool refreshes", () => {
  /**
   * A registration that lands while a refresh is running used to be dropped:
   * the pass in flight had already read the registry, and the request it
   * suppressed was the only one that would have looked again. The tool then
   * stayed off the lane until something else drove a turn.
   */
  it("installs a tool registered while a refresh is in flight", async () => {
    const active = await fresh().overlappingToolRefresh();
    expect(active).toContain("late-one");
    expect(active).toContain("late-two");
  });
});
