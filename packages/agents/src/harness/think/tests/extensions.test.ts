import {
  asSchema,
  convertToModelMessages,
  jsonSchema,
  streamText,
  tool,
  type Tool,
  type ToolSet,
  type UIMessage
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { harnessHookRules } from "../extensions/hooks";
import { ExtensionManager } from "../extensions/manager";
import { optionsExtension } from "../extensions/own";
import { loadInProcess } from "../extensions/in-process";
import type {
  ExtensionHandle,
  ThinkExtension,
  ToolCall
} from "../extensions/types";
import { executeTool, modelTools } from "../tools";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1
  },
  outputTokens: { reasoning: undefined, text: 1, total: 1 }
};

/** A model that records each request and answers with one tool call. */
function recordingModel(requests: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      requests.push({
        tools: options.tools,
        toolChoice: options.toolChoice,
        prompt: options.prompt
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "c1",
              toolName: "lookup",
              input: "{}"
            });
            controller.enqueue({
              type: "finish",
              finishReason: { raw: "tool-calls", unified: "tool-calls" },
              usage
            });
            controller.close();
          }
        })
      };
    }
  });
}

/** Every kind of tool and tool field the harness's options accept. */
function sampleTools() {
  const tools = {
    lookup: {
      ...tool({
        description: "Look a word up",
        inputSchema: z.object({
          word: z.string().default("hello"),
          limit: z.number().int().max(10).optional()
        }),
        providerOptions: { test: { cache: true } },
        strict: true,
        inputExamples: [{ input: { word: "cat" } }],
        execute: async ({ word }) => ({ word, found: true }),
        toModelOutput: ({ output }) => ({
          type: "text",
          value: `found ${JSON.stringify(output)}`
        })
      }),
      recovery: "rerun"
    },
    described: tool({
      description: () => "Described by a function",
      inputSchema: jsonSchema<{ n: number }>({
        type: "object",
        properties: { n: { type: "number" } }
      }),
      execute: async ({ n }) => n
    }),
    ask: tool({
      description: "Runs on the client",
      inputSchema: z.object({ question: z.string() })
    }),
    approve: tool({
      description: "Needs approval",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => "done"
    })
  };
  // SAFETY: `recovery` is the harness's field on an AI SDK tool.
  return tools as ToolSet;
}

const history: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-lookup",
        toolCallId: "c0",
        state: "output-available",
        input: { word: "dog" },
        output: { word: "dog", found: true }
      }
    ]
  },
  { id: "u2", role: "user", parts: [{ type: "text", text: "Again" }] }
];

async function send(tools: ToolSet, system: string | undefined) {
  const requests: unknown[] = [];
  const result = streamText({
    model: recordingModel(requests),
    ...(system !== undefined && { system }),
    messages: await convertToModelMessages(history, {
      tools,
      ignoreIncompleteToolCalls: true
    }),
    tools: modelTools(tools, undefined)
  });
  const calls = await result.toolCalls;
  return { request: JSON.stringify(requests), calls };
}

/** A handle whose every argument and result crosses as a clone. */
function acrossBoundary(handle: ExtensionHandle): ExtensionHandle {
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    describe: async () => clone(await handle.describe()),
    build: async (drafts, build) =>
      clone(await handle.build(clone(drafts), clone(build))),
    execute: async (name, input, call, onOutput) =>
      clone(
        await handle.execute(clone(name), clone(input), clone(call), (o) =>
          onOutput(clone(o))
        )
      ),
    cancel: (call, reason) => handle.cancel(clone(call), clone(reason)),
    validate: async (name, input, build) =>
      clone(await handle.validate(name, clone(input), clone(build))),
    modelOutput: async (name, output, build) =>
      clone(await handle.modelOutput(name, clone(output), clone(build))),
    needsApproval: async (name, input, call) =>
      clone(await handle.needsApproval(name, clone(input), clone(call))),
    hook: async (name, context) =>
      clone(await handle.hook(name, clone(context)))
  };
}

const call = (id: string): ToolCall => ({ id, session: "", messages: [] });

describe("extensions: the build", () => {
  it("sends the same request as the options given directly, byte for byte", async () => {
    const tools = sampleTools();
    const direct = await send(tools, "Be brief.");

    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "options",
      loadInProcess(
        "options",
        optionsExtension({ tools: () => tools, system: "Be brief." })
      )
    );
    const built = await manager.build("");
    expect(built.system).toBe("Be brief.");
    const through = await send(built.tools, built.system);

    expect(through.request).toBe(direct.request);
    // The input is validated by the tool's own schema: its default applies.
    expect(through.calls.map((c) => c.input)).toEqual([{ word: "hello" }]);
    expect(through.calls).toEqual(direct.calls);
  });

  it("keeps a tool's output schema, as JSON Schema, and still sends the same request", async () => {
    const withOutput = {
      lookup: tool({
        description: "Look a word up",
        inputSchema: z.object({ word: z.string() }),
        outputSchema: z.object({ found: z.boolean() }),
        execute: async () => ({ found: true })
      })
    };
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "options",
      loadInProcess("options", optionsExtension({ tools: withOutput }))
    );
    const built = await manager.build("");
    expect(await asSchema(built.tools.lookup?.outputSchema).jsonSchema).toEqual(
      await asSchema(withOutput.lookup.outputSchema).jsonSchema
    );
    expect((await send(built.tools, undefined)).request).toBe(
      (await send(withOutput, undefined)).request
    );
  });

  it("leaves out an output schema with no JSON Schema, instead of failing the build", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = {
      dated: tool({
        description: "Has a date",
        inputSchema: z.object({}),
        outputSchema: z.object({ at: z.date() }),
        execute: async () => ({ at: new Date(0) })
      }),
      big: tool({
        description: "Has a bigint",
        inputSchema: z.object({}),
        outputSchema: z.object({ n: z.bigint() }),
        execute: async () => ({ n: 1n })
      }),
      // A schema whose JSON Schema comes later and fails.
      later: tool({
        description: "Has a schema that rejects",
        inputSchema: z.object({}),
        outputSchema: jsonSchema<{ ok: boolean }>(() =>
          Promise.reject(new Error("no JSON Schema"))
        ),
        execute: async () => ({ ok: true })
      })
    };
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "options",
      loadInProcess("options", optionsExtension({ tools }))
    );
    const built = await manager.build("");
    warn.mockRestore();
    expect(Object.keys(built.tools)).toEqual(["dated", "big", "later"]);
    expect(built.tools.dated?.outputSchema).toBeUndefined();
    expect(built.tools.big?.outputSchema).toBeUndefined();
    expect(built.tools.later?.outputSchema).toBeUndefined();
    expect((await send(built.tools, undefined)).request).toBe(
      (await send(tools, undefined)).request
    );
  });

  it("builds the same tools and prompt twice, and in order", async () => {
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "first",
      loadInProcess("first", (ctx) => {
        ctx.tools.transform((tools) => {
          tools.set("a", sampleTools().lookup);
          tools.set("b", sampleTools().described);
        });
        ctx.prompt.transform((prompt) => prompt.set("one", { text: "One." }));
      })
    );
    manager.load(
      "second",
      loadInProcess("second", (ctx) => {
        ctx.tools.transform((tools) => {
          expect(tools.get("a")?.owner).toBe("first");
          tools.delete("b");
          tools.set("c", sampleTools().approve);
        });
        ctx.prompt.transform((prompt) => prompt.set("two", { text: "Two." }));
      })
    );
    const once = await manager.build("");
    const twice = await manager.build("");
    expect(Object.keys(once.tools)).toEqual(["a", "c"]);
    expect(once.system).toBe("One.\n\nTwo.");
    expect(JSON.stringify(modelTools(twice.tools, undefined))).toBe(
      JSON.stringify(modelTools(once.tools, undefined))
    );
  });

  it("gives a tool set again to the later extension, in its place", async () => {
    const ran: string[] = [];
    const setter =
      (label: string): ThinkExtension =>
      (ctx) =>
        ctx.tools.transform((tools) => {
          tools.set("x", {
            ...tool({
              description: label,
              inputSchema: z.object({}),
              execute: async () => {
                ran.push(label);
                return label;
              }
            })
          });
          if (label === "early") tools.set("y", sampleTools().described);
        });
    const manager = new ExtensionManager(harnessHookRules);
    manager.load("early", loadInProcess("early", setter("early")));
    manager.load("late", loadInProcess("late", setter("late")));
    const { tools } = await manager.build("");
    expect(Object.keys(tools)).toEqual(["x", "y"]);
    expect(tools.x?.description).toBe("late");
    // A tool that does not stream returns its one output, as the AI SDK
    // expects of a plain tool.
    expect(
      await tools.x?.execute?.(
        {},
        { toolCallId: "c", messages: [], context: undefined }
      )
    ).toBe("late");
    expect(ran).toEqual(["late"]);
  });

  it("lets a later extension make another's tool code-only, which its owner still runs", async () => {
    const ran: string[] = [];
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "owner",
      loadInProcess("owner", (ctx) =>
        ctx.tools.transform((tools) => {
          tools.set("x", {
            ...tool({
              description: "x",
              inputSchema: z.object({}),
              execute: async () => {
                ran.push("owner");
                return "from the owner";
              }
            })
          });
        })
      )
    );
    manager.load(
      "later",
      loadInProcess("later", (ctx) =>
        ctx.tools.transform((tools) => {
          expect(tools.setCallers("x", ["code"])).toBe(true);
          expect(tools.setCallers("missing", ["code"])).toBe(false);
        })
      )
    );
    const { tools } = await manager.build("");
    expect(Object.keys(modelTools(tools, undefined))).toEqual([]);
    expect((tools.x as { callers?: unknown }).callers).toEqual(["code"]);
    expect(
      await tools.x?.execute?.(
        {},
        { toolCallId: "c", messages: [], context: undefined }
      )
    ).toBe("from the owner");
    expect(ran).toEqual(["owner"]);
  });

  it("keeps a tool callable on the build it came from after a later build drops it", async () => {
    let offered = true;
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "toggle",
      loadInProcess("toggle", (ctx) =>
        ctx.tools.transform((tools) => {
          if (!offered) return;
          tools.set(
            "x",
            tool({
              description: "x",
              inputSchema: z.object({}),
              execute: async () => "ran"
            })
          );
        })
      )
    );
    const pinned = (await manager.build("")).tools;
    // Another build, as a watch makes, no longer has the tool.
    offered = false;
    expect(Object.keys((await manager.build("")).tools)).toEqual([]);
    expect(
      await pinned.x?.execute?.(
        {},
        { toolCallId: "c", messages: [], context: undefined }
      )
    ).toBe("ran");
  });

  it("refuses a transform registered after the extension returned", async () => {
    let late: (() => void) | undefined;
    const handle = await loadInProcess("late", (ctx) => {
      late = () => ctx.tools.transform(() => {});
    });
    expect(handle).toBeDefined();
    expect(late).toThrow('Extension "late" registered a tool transform');
  });
});

describe("extensions: conformance in process and across a boundary", () => {
  const extension: ThinkExtension = (ctx) => {
    ctx.tools.transform((tools, { session }) => {
      tools.set("lookup", sampleTools().lookup);
      tools.set("approve", {
        ...tool({
          description: `Approve in ${session || "root"}`,
          inputSchema: z.object({ amount: z.number() }),
          needsApproval: ({ amount }) => amount > 10,
          execute: async function* ({ amount }) {
            yield "checking";
            yield `approved ${amount}`;
          }
        })
      });
      tools.set("fail", {
        ...tool({
          description: "Always fails",
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error("it failed");
          }
        })
      });
    });
    ctx.prompt.transform((prompt) => prompt.set("rules", { text: "Rules." }));
    ctx.on("beforeToolCall", ({ toolName, input }) =>
      toolName === "fail"
        ? { action: "block", reason: "no" }
        : { action: "run", input: { ...(input as object), checked: true } }
    );
    ctx.on("beforeToolCall", ({ input }) =>
      (input as { word?: string }).word === "stop"
        ? { action: "substitute", output: "stopped" }
        : undefined
    );
    ctx.on("classifyError", ({ error }) =>
      String(error).includes("overflow") ? "context-overflow" : undefined
    );
    ctx.on("onRecovery", ({ attempt }) =>
      attempt > 2 ? "abandon" : "continue"
    );
  };

  async function observe(handle: Promise<ExtensionHandle>) {
    const manager = new ExtensionManager(harnessHookRules);
    manager.load("ext", handle);
    const direct = await handle;
    const built = await manager.build("s");
    const executed: unknown[] = [];
    for (const [name, input] of [
      ["lookup", { word: "dog" }],
      ["approve", { amount: 3 }],
      ["fail", {}]
    ] as const) {
      const outputs: unknown[] = [];
      executed.push({
        outcome: await direct.execute(
          name,
          input,
          { ...call("c"), session: "s" },
          (o) => {
            outputs.push(o);
          }
        ),
        outputs
      });
    }
    const hookContext = {
      session: "s",
      operationId: "op",
      toolCallId: "c",
      toolName: "lookup",
      input: { word: "stop" },
      attempt: 1
    };
    return {
      tools: JSON.stringify(modelTools(built.tools, undefined)),
      system: built.system,
      executed,
      describe: await direct.describe(),
      validate: await direct.validate("lookup", {}, { session: "s" }),
      modelOutput: await direct.modelOutput(
        "lookup",
        { toolCallId: "c", input: {}, output: { found: true } },
        { session: "s" }
      ),
      approval: [
        await direct.needsApproval(
          "approve",
          { amount: 3 },
          { ...call("c"), session: "s" }
        ),
        await direct.needsApproval(
          "approve",
          { amount: 30 },
          { ...call("c"), session: "s" }
        )
      ],
      decisions: [
        await manager.hook("beforeToolCall", hookContext),
        await manager.hook("beforeToolCall", {
          ...hookContext,
          input: { word: "go" }
        }),
        await manager.hook("beforeToolCall", {
          ...hookContext,
          toolName: "fail"
        })
      ],
      classes: [
        await manager.hook("classifyError", { error: new Error("overflow") }),
        await manager.hook("classifyError", { error: new Error("other") })
      ],
      recovery: [
        await manager.hook("onRecovery", {
          session: "s",
          operationId: "op",
          attempt: 1,
          partial: undefined
        }),
        await manager.hook("onRecovery", {
          session: "s",
          operationId: "op",
          attempt: 3,
          partial: undefined
        })
      ]
    };
  }

  it("gives the same entries, results and decisions both ways", async () => {
    const inProcess = await observe(loadInProcess("ext", extension));
    const crossed = await observe(
      loadInProcess("ext", extension).then(acrossBoundary)
    );
    expect(crossed).toEqual(inProcess);
    expect(inProcess.executed).toEqual([
      {
        outcome: { ok: true, output: { word: "dog", found: true } },
        outputs: []
      },
      {
        outcome: { ok: true, output: "approved 3" },
        outputs: ["checking", "approved 3"]
      },
      { outcome: { ok: false, errorText: "it failed" }, outputs: [] }
    ]);
    expect(inProcess.validate).toEqual({
      success: true,
      value: { word: "hello" }
    });
    expect(inProcess.approval).toEqual([false, true]);
    expect(inProcess.decisions).toEqual([
      { action: "substitute", output: "stopped" },
      { action: "run", input: { word: "go", checked: true } },
      { action: "block", reason: "no" }
    ]);
    expect(inProcess.classes).toEqual(["context-overflow", undefined]);
    expect(inProcess.recovery).toEqual([undefined, "abandon"]);
  });

  it("cancels the call of one session, not another's with the same id", async () => {
    const started: string[] = [];
    const handle = await loadInProcess("slow", (ctx) =>
      ctx.tools.transform((tools, { session }) =>
        tools.set("wait", {
          ...tool({
            description: "Waits for its signal",
            inputSchema: z.object({}),
            execute: (_input, { abortSignal }) =>
              new Promise<string>((_resolve, reject) => {
                started.push(session);
                abortSignal?.addEventListener("abort", () =>
                  reject(new Error(`${session}: ${String(abortSignal.reason)}`))
                );
              })
          })
        })
      )
    );
    for (const session of ["a", "b"]) {
      await handle.build({ tools: [], prompt: [] }, { session });
    }
    const a = handle.execute(
      "wait",
      {},
      { ...call("w"), session: "a" },
      () => {}
    );
    const b = handle.execute(
      "wait",
      {},
      { ...call("w"), session: "b" },
      () => {}
    );
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    handle.cancel({ id: "w", session: "a" }, "stopped");
    expect(await a).toEqual({ ok: false, errorText: "a: stopped" });
    let bSettled = false;
    void b.then(() => {
      bSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bSettled).toBe(false);
    handle.cancel({ id: "w", session: "b" }, "stopped");
    expect(await b).toEqual({ ok: false, errorText: "b: stopped" });
  });

  it("does not start a tool whose call is already aborted", async () => {
    let ran = false;
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "options",
      loadInProcess(
        "options",
        optionsExtension({
          tools: {
            act: tool({
              description: "Acts",
              inputSchema: z.object({}),
              execute: async () => {
                ran = true;
                return "acted";
              }
            })
          }
        })
      )
    );
    const { tools } = await manager.build("");
    const stop = new AbortController();
    stop.abort(new Error("turn stopped"));
    const outcome = await executeTool(
      tools.act as Tool,
      {},
      {
        toolCallId: "c",
        messages: [],
        abortSignal: stop.signal,
        onPreliminary: () => {}
      }
    );
    expect(outcome).toEqual({ ok: false, errorText: "turn stopped" });
    expect(ran).toBe(false);
  });

  it("passes on a streaming tool's outputs as the tool itself yields them", async () => {
    async function* yields(fail: boolean) {
      yield "one";
      yield "two";
      if (fail) throw new Error("broke");
      yield "three";
    }
    const kinds = {
      // Declared as an async generator.
      generator: (fail: boolean) =>
        tool({
          description: "Streams",
          inputSchema: z.object({}),
          execute: async function* () {
            yield* yields(fail);
          }
        }),
      // A plain function whose result turns out to stream.
      returnsIterable: (fail: boolean) =>
        tool({
          description: "Streams",
          inputSchema: z.object({}),
          execute: () => yields(fail)
        })
    };
    for (const make of Object.values(kinds)) {
      for (const fail of [false, true]) {
        const original = make(fail);
        const manager = new ExtensionManager(harnessHookRules);
        manager.load(
          "options",
          loadInProcess("options", optionsExtension({ tools: { s: original } }))
        );
        const { tools } = await manager.build("");
        const run = async (target: Tool) => {
          const preliminary: unknown[] = [];
          const outcome = await executeTool(
            target,
            {},
            {
              toolCallId: "c",
              messages: [],
              abortSignal: new AbortController().signal,
              onPreliminary: (output) => preliminary.push(output)
            }
          );
          return { outcome, preliminary };
        };
        const through = await run(tools.s as Tool);
        expect(through).toEqual(await run(original));
        expect(through.preliminary).toEqual(
          ["one", "two"].slice(0, fail ? 1 : 2)
        );
      }
    }
  });

  it("calls the options' hooks as methods of the hooks object", async () => {
    const hooks = {
      label: "mine",
      seen: [] as string[],
      beforeToolCall(this: { label: string; seen: string[] }) {
        this.seen.push(this.label);
        return undefined;
      },
      classifyError(this: { label: string }) {
        return this.label === "mine" ? ("retry" as const) : ("fail" as const);
      }
    };
    const manager = new ExtensionManager(harnessHookRules);
    manager.load(
      "options",
      loadInProcess("options", optionsExtension({ hooks }))
    );
    await manager.hook("beforeToolCall", {
      session: "",
      operationId: "op",
      toolCallId: "c",
      toolName: "x",
      input: {},
      attempt: 1
    });
    expect(hooks.seen).toEqual(["mine"]);
    expect(await manager.hook("classifyError", { error: new Error("x") })).toBe(
      "retry"
    );
  });
});
