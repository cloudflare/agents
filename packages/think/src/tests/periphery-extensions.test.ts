import type { UIMessage } from "ai";
import type { ContextBlocks } from "agents/context";
import { manifest } from "agents/skills";
import { describe, expect, it, vi } from "vitest";
import { callThinkHostApi, createThinkHostApi } from "../extensions/host-api";
import type { ExtensionManager } from "../extensions/manager";
import { ThinkExtensionHooks } from "../extensions/pipeline";
import { SKILLS_CONTEXT_LABEL, ThinkSkills } from "../skills-runtime";
import type { TurnContext } from "../turn-types";
import type { ThinkWorkspace } from "../workspace-files";

type Hook = (name: string, snapshot: unknown) => Promise<string>;

function fakeManager(subscribers: Record<string, Array<[string, Hook]>>) {
  return {
    getHookSubscribers: (hookName: string) =>
      (subscribers[hookName] ?? []).map(([name, hook]) => ({
        name,
        entrypoint: { hook }
      }))
  } as unknown as ExtensionManager;
}

const turnContext = {
  system: "base",
  messages: [],
  tools: {},
  model: "@cf/test/model",
  continuation: false
} as unknown as TurnContext;

describe("ThinkExtensionHooks.beforeTurn", () => {
  it("returns the subclass config when no extension subscribes", async () => {
    const hooks = new ThinkExtensionHooks({
      manager: () => fakeManager({}),
      timeoutMs: () => 50
    });
    const config = { maxSteps: 3 };
    expect(await hooks.beforeTurn(turnContext, config)).toBe(config);
  });

  it("pipes the config through extensions in order", async () => {
    const seen: unknown[] = [];
    const hooks = new ThinkExtensionHooks({
      manager: () =>
        fakeManager({
          beforeTurn: [
            [
              "first",
              async (_name, snapshot) => {
                seen.push(snapshot);
                return JSON.stringify({
                  result: {
                    system: "from first",
                    temperature: 0.2,
                    headers: { a: "1" },
                    model: "ignored"
                  }
                });
              }
            ],
            [
              "second",
              async (_name, snapshot) => {
                seen.push(snapshot);
                return JSON.stringify({
                  result: { activeTools: ["x"], headers: { b: "2" } }
                });
              }
            ]
          ]
        }),
      timeoutMs: () => 50
    });
    const config = await hooks.beforeTurn(turnContext, {
      maxSteps: 4,
      headers: { base: "0" }
    });
    expect(config).toEqual({
      maxSteps: 4,
      system: "from first",
      temperature: 0.2,
      activeTools: ["x"],
      headers: { base: "0", a: "1", b: "2" }
    });
    expect((seen[1] as { system: string }).system).toBe("from first");
  });

  it("skips an extension that fails or times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hooks = new ThinkExtensionHooks({
      manager: () =>
        fakeManager({
          beforeTurn: [
            ["slow", () => new Promise<string>(() => {})],
            [
              "broken",
              async () => {
                throw new Error("boom");
              }
            ],
            ["errors", async () => JSON.stringify({ error: "bad" })],
            ["good", async () => JSON.stringify({ result: { seed: 7 } })]
          ]
        }),
      timeoutMs: () => 10
    });
    expect(await hooks.beforeTurn(turnContext, {})).toEqual({ seed: 7 });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("ThinkExtensionHooks observations", () => {
  it("sends a snapshot to each subscriber and ignores failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    const hooks = new ThinkExtensionHooks({
      manager: () =>
        fakeManager({
          onChunk: [
            [
              "a",
              async (name) => {
                calls.push(`a:${name}`);
                throw new Error("ignored");
              }
            ],
            [
              "b",
              async (name) => {
                calls.push(`b:${name}`);
                return "";
              }
            ]
          ]
        }),
      timeoutMs: () => 50
    });
    await hooks.chunk({ chunk: { type: "text-delta" } } as never);
    await hooks.stepFinish({} as never);
    expect(calls).toEqual(["a:onChunk", "b:onChunk"]);
    warn.mockRestore();
  });

  it("does nothing without an extension manager", async () => {
    const hooks = new ThinkExtensionHooks({
      manager: () => undefined,
      timeoutMs: () => 50
    });
    const config = {};
    expect(await hooks.beforeTurn(turnContext, config)).toBe(config);
    await hooks.chunk({ chunk: { type: "text-delta" } } as never);
  });
});

describe("createThinkHostApi", () => {
  const messages: UIMessage[] = [
    { id: "1", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "2",
      role: "assistant",
      parts: [
        { type: "text", text: "he" },
        { type: "reasoning", text: "x" },
        { type: "text", text: "llo" }
      ]
    }
  ];

  function api(appended: UIMessage[] = []) {
    const blocks = new Map([["memory", "remembered"]]);
    return createThinkHostApi({
      workspace: () => ({}) as ThinkWorkspace,
      context: () =>
        ({
          getBlock: (label: string) =>
            blocks.has(label) ? { content: blocks.get(label) } : undefined,
          setBlock: async (label: string, content: string) => {
            blocks.set(label, content);
          }
        }) as unknown as ContextBlocks,
      messages: () => messages,
      appendMessage: async (message) => {
        appended.push(message);
      }
    });
  }

  it("reads messages as text, sliced from the end", async () => {
    const host = api();
    expect(await host.getMessages()).toEqual([
      { id: "1", role: "user", content: "hi" },
      { id: "2", role: "assistant", content: "hello" }
    ]);
    expect((await host.getMessages(1)).map((m) => m.id)).toEqual(["2"]);
    expect(await host.getMessages(0)).toEqual([]);
    expect(await host.getSessionInfo()).toEqual({ messageCount: 2 });
  });

  it("reads and writes context blocks", async () => {
    const host = api();
    expect(await host.getContext("memory")).toBe("remembered");
    expect(await host.getContext("missing")).toBeNull();
    await host.setContext("memory", "new");
    expect(await host.getContext("memory")).toBe("new");
  });

  it("appends a sent message as a user message", async () => {
    const appended: UIMessage[] = [];
    await api(appended).sendMessage("from extension");
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("user");
    expect(appended[0].parts).toEqual([
      { type: "text", text: "from extension" }
    ]);
  });

  it("dispatches by name and rejects unknown operations", async () => {
    const host = api();
    expect(await callThinkHostApi(host, "getContext", ["memory"])).toBe(
      "remembered"
    );
    expect(() =>
      callThinkHostApi(host, "toString" as "getContext", ["memory"])
    ).toThrow(/Unknown host operation/);
  });
});

describe("ThinkSkills", () => {
  function fakeContext() {
    const blocks: Array<{ label: string; get: () => Promise<string> }> = [];
    const context = {
      addBlock: async (block: {
        label: string;
        provider: { get: () => Promise<string> };
      }) => {
        blocks.push({ label: block.label, get: block.provider.get });
      }
    } as unknown as ContextBlocks;
    return { context, blocks };
  }

  it("stays off without sources", async () => {
    const skills = new ThinkSkills();
    const { context, blocks } = fakeContext();
    await skills.initialize(() => [], context);
    expect(blocks).toEqual([]);
    expect(skills.tools(() => null)).toEqual({});
  });

  it("registers the catalog block and gives the turn skill tools", async () => {
    const skills = new ThinkSkills();
    const { context, blocks } = fakeContext();
    await skills.initialize(
      () => [
        manifest({
          id: "test",
          skills: [
            { name: "greet", description: "Say hello.", body: "Say hello." }
          ]
        })
      ],
      context
    );
    expect(blocks.map((b) => b.label)).toEqual([SKILLS_CONTEXT_LABEL]);
    expect(await blocks[0].get()).toContain("greet");
    await skills.refresh();
    expect(Object.keys(skills.tools(() => null)).length).toBeGreaterThan(0);
  });

  it("logs and continues when getSkills throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skills = new ThinkSkills();
    const { context, blocks } = fakeContext();
    await skills.initialize(() => {
      throw new Error("no sources");
    }, context);
    expect(blocks).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
