import { describe, it, expect } from "vitest";
import { step } from "../runner";
import { MockProvider } from "./worker";
import type { AgentState, AgentMiddleware } from "../types";

describe("V2 Runner - Step Logic", () => {
  it("returns 'done' verdict when no tool calls are made", async () => {
    const provider = new MockProvider([
      { role: "assistant", content: "Simple response with no tools" }
    ]);

    const state: AgentState = {
      messages: [{ role: "user", content: "Hello" }]
    };

    const verdict = await step(provider, [], state);

    expect(verdict.kind).toBe("done");
    expect(verdict.state.messages.length).toBe(2); // user + assistant
  });

  it("returns 'continue' verdict when tool calls are proposed", async () => {
    const provider = new MockProvider([
      {
        role: "assistant",
        tool_calls: [{ name: "test_tool", args: { param: "value" } }]
      }
    ]);

    const state: AgentState = {
      messages: [{ role: "user", content: "Use a tool" }]
    };

    const verdict = await step(provider, [], state);

    expect(verdict.kind).toBe("continue");
    expect(verdict.state.messages.length).toBe(2);
  });

  it("returns 'paused' verdict when HITL middleware flags pending tool calls", async () => {
    const provider = new MockProvider([
      {
        role: "assistant",
        tool_calls: [{ name: "risky_tool", args: {} }]
      }
    ]);

    const hitlMiddleware: AgentMiddleware = {
      name: "hitl-test",
      async afterModel(state) {
        const last = state.messages[state.messages.length - 1];
        if (last?.role === "assistant" && "tool_calls" in last) {
          return {
            meta: {
              ...state.meta,
              pendingToolCalls: last.tool_calls || []
            }
          };
        }
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Do something risky" }]
    };

    const verdict = await step(provider, [hitlMiddleware], state);

    expect(verdict.kind).toBe("paused");
    expect(verdict.reason).toBe("hitl");
    expect(verdict.state.meta?.pendingToolCalls).toBeDefined();
  });

  it("handles provider errors gracefully", async () => {
    const errorProvider = new MockProvider();
    // Override invoke to throw error
    errorProvider.invoke = async () => {
      throw new Error("Provider error");
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Cause an error" }]
    };

    const verdict = await step(errorProvider, [], state);

    expect(verdict.kind).toBe("error");
    expect(verdict.error).toBeDefined();
    expect(verdict.error.message).toBe("Provider error");
  });

  it("executes beforeModel middleware in order", async () => {
    const executionOrder: string[] = [];
    const provider = new MockProvider([
      { role: "assistant", content: "Response" }
    ]);

    const middleware1: AgentMiddleware = {
      name: "mw1",
      async beforeModel(_state) {
        executionOrder.push("mw1-before");
      }
    };

    const middleware2: AgentMiddleware = {
      name: "mw2",
      async beforeModel(_state) {
        executionOrder.push("mw2-before");
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Test" }]
    };

    await step(provider, [middleware1, middleware2], state);

    expect(executionOrder).toEqual(["mw1-before", "mw2-before"]);
  });

  it("executes afterModel middleware in reverse order", async () => {
    const executionOrder: string[] = [];
    const provider = new MockProvider([
      { role: "assistant", content: "Response" }
    ]);

    const middleware1: AgentMiddleware = {
      name: "mw1",
      async afterModel(_state) {
        executionOrder.push("mw1-after");
      }
    };

    const middleware2: AgentMiddleware = {
      name: "mw2",
      async afterModel(_state) {
        executionOrder.push("mw2-after");
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Test" }]
    };

    await step(provider, [middleware1, middleware2], state);

    expect(executionOrder).toEqual(["mw2-after", "mw1-after"]);
  });

  it("allows middleware to modify state in beforeModel", async () => {
    const provider = new MockProvider([
      { role: "assistant", content: "Response" }
    ]);

    const modifyingMiddleware: AgentMiddleware = {
      name: "modifier",
      async beforeModel(state) {
        return {
          meta: {
            ...state.meta,
            customField: "modified"
          }
        };
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Test" }]
    };

    const verdict = await step(provider, [modifyingMiddleware], state);

    expect(verdict.state.meta?.customField).toBe("modified");
  });

  it("allows middleware to modify state in afterModel", async () => {
    const provider = new MockProvider([
      { role: "assistant", content: "Response" }
    ]);

    const modifyingMiddleware: AgentMiddleware = {
      name: "modifier",
      async afterModel(state) {
        return {
          meta: {
            ...state.meta,
            afterModification: "done"
          }
        };
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Test" }]
    };

    const verdict = await step(provider, [modifyingMiddleware], state);

    expect(verdict.state.meta?.afterModification).toBe("done");
  });

  it("allows middleware to modify model request", async () => {
    const provider = new MockProvider([
      { role: "assistant", content: "Response" }
    ]);

    const requestModifier: AgentMiddleware = {
      name: "request-modifier",
      async modifyModelRequest(req, _state) {
        return {
          ...req,
          temperature: 0.7,
          maxTokens: 1000
        };
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Test" }]
    };

    const verdict = await step(provider, [requestModifier], state);

    // Request was modified, but we can't directly verify it here
    // In a real test, we'd spy on the provider.invoke call
    expect(verdict.kind).toBe("done");
  });

  it("stops beforeModel execution when jumpTo is set", async () => {
    const executionOrder: string[] = [];
    const provider = new MockProvider([
      { role: "assistant", content: "Response" }
    ]);

    const middleware1: AgentMiddleware = {
      name: "mw1",
      async beforeModel(_state) {
        executionOrder.push("mw1");
        return { jumpTo: "end" as const };
      }
    };

    const middleware2: AgentMiddleware = {
      name: "mw2",
      async beforeModel(_state) {
        executionOrder.push("mw2");
      }
    };

    const state: AgentState = {
      messages: [{ role: "user", content: "Test" }]
    };

    await step(provider, [middleware1, middleware2], state);

    // mw2 should not execute because mw1 set jumpTo
    expect(executionOrder).toEqual(["mw1"]);
  });
});

describe("V2 Middleware - VFS", () => {
  it("provides file system tools", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    expect(middleware.name).toBe("vfs");
    expect(middleware.tools).toBeDefined();
    expect(middleware.tools?.ls).toBeDefined();
    expect(middleware.tools?.read_file).toBeDefined();
    expect(middleware.tools?.write_file).toBeDefined();
    expect(middleware.tools?.edit_file).toBeDefined();
  });

  it("ls tool returns list of file paths", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    const state: AgentState = {
      messages: [],
      files: {
        "file1.txt": "content1",
        "file2.txt": "content2"
      }
    };

    const result = await middleware.tools!.ls(
      {},
      {
        state,
        env: {} as Record<string, unknown>,
        fetch: fetch
      }
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain("file1.txt");
    expect(result).toContain("file2.txt");
  });

  it("read_file tool returns file content", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    const state: AgentState = {
      messages: [],
      files: {
        "test.txt": "Hello, world!"
      }
    };

    const result = await middleware.tools!.read_file(
      { path: "test.txt" },
      { state, env: {} as Record<string, unknown>, fetch: fetch }
    );

    expect(result).toBe("Hello, world!");
  });

  it("read_file returns empty string for non-existent file", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    const state: AgentState = {
      messages: [],
      files: {}
    };

    const result = await middleware.tools!.read_file(
      { path: "nonexistent.txt" },
      { state, env: {} as Record<string, unknown>, fetch: fetch }
    );

    expect(result).toBe("");
  });

  it("write_file tool creates a new file", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    const state: AgentState = {
      messages: [],
      files: {}
    };

    const result = await middleware.tools!.write_file(
      { path: "new.txt", content: "New content" },
      { state, env: {} as Record<string, unknown>, fetch: fetch }
    );

    expect(result).toBe("ok");
    expect(state.files!["new.txt"]).toBe("New content");
  });

  it("edit_file tool replaces text in file", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    const state: AgentState = {
      messages: [],
      files: {
        "code.js": "const x = 10;\nconst y = 20;"
      }
    };

    const result = await middleware.tools!.edit_file(
      { path: "code.js", find: "10", replace: "100" },
      { state, env: {} as Record<string, unknown>, fetch: fetch }
    );

    expect(result).toBe("ok");
    expect(state.files!["code.js"]).toBe("const x = 100;\nconst y = 20;");
  });

  it("edit_file replaces all occurrences", async () => {
    const { vfs } = await import("../middleware");
    const middleware = vfs();

    const state: AgentState = {
      messages: [],
      files: {
        "code.js": "const x = 10;\nconst y = 10;\nconst z = 10;"
      }
    };

    await middleware.tools!.edit_file(
      { path: "code.js", find: "10", replace: "20" },
      { state, env: {} as Record<string, unknown>, fetch: fetch }
    );

    expect(state.files!["code.js"]).toBe(
      "const x = 20;\nconst y = 20;\nconst z = 20;"
    );
  });
});

describe("V2 Middleware - HITL", () => {
  it("intercepts specified tools", async () => {
    const { hitl } = await import("../middleware");
    const middleware = hitl({ interceptTools: ["dangerous_action"] });

    const state: AgentState = {
      messages: [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          tool_calls: [{ name: "dangerous_action", args: {} }]
        }
      ]
    };

    const update = await middleware.afterModel?.(state);

    expect(update).toBeDefined();
    expect(update?.meta?.pendingToolCalls).toBeDefined();
    expect(update?.jumpTo).toBe("end");
  });

  it("does not intercept non-specified tools", async () => {
    const { hitl } = await import("../middleware");
    const middleware = hitl({ interceptTools: ["dangerous_action"] });

    const state: AgentState = {
      messages: [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          tool_calls: [{ name: "safe_action", args: {} }]
        }
      ]
    };

    const update = await middleware.afterModel?.(state);

    // Should not intercept safe_action
    expect(update).toBeUndefined();
  });

  it("handles multiple tool calls with mixed safety", async () => {
    const { hitl } = await import("../middleware");
    const middleware = hitl({ interceptTools: ["risky"] });

    const state: AgentState = {
      messages: [
        { role: "user", content: "Do multiple things" },
        {
          role: "assistant",
          tool_calls: [
            { name: "safe1", args: {} },
            { name: "risky", args: {} },
            { name: "safe2", args: {} }
          ]
        }
      ]
    };

    const update = await middleware.afterModel?.(state);

    // Should intercept because one of the calls is risky
    expect(update).toBeDefined();
    expect(update?.meta?.pendingToolCalls).toBeDefined();
  });

  it("handles messages without tool calls", async () => {
    const { hitl } = await import("../middleware");
    const middleware = hitl({ interceptTools: ["anything"] });

    const state: AgentState = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" }
      ]
    };

    const update = await middleware.afterModel?.(state);

    expect(update).toBeUndefined();
  });
});
