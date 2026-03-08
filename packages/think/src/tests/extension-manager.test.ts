/**
 * Tests for the Extension system: ExtensionManager, HostBridge, and
 * the extension Worker contract.
 *
 * Uses vitest-pool-workers with a real WorkerLoader binding.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "./worker";
import { ExtensionManager, sanitizeName } from "../extensions/manager";
import type { ExtensionManifest } from "../extensions/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Simple extension source: a greet tool that returns a greeting
const GREET_EXTENSION_SOURCE = `{
  greet: {
    description: "Greet someone by name",
    parameters: { name: { type: "string", description: "Name to greet" } },
    required: ["name"],
    execute: async (args) => "Hello, " + args.name + "!"
  }
}`;

// Multi-tool extension
const MULTI_TOOL_SOURCE = `{
  add: {
    description: "Add two numbers",
    parameters: {
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" }
    },
    required: ["a", "b"],
    execute: async (args) => args.a + args.b
  },
  multiply: {
    description: "Multiply two numbers",
    parameters: {
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" }
    },
    required: ["a", "b"],
    execute: async (args) => args.a * args.b
  }
}`;

// Extension that uses the host bridge for workspace access
const _WORKSPACE_EXTENSION_SOURCE = `{
  readFile: {
    description: "Read a file via host bridge",
    parameters: { path: { type: "string" } },
    required: ["path"],
    execute: async (args, host) => {
      const content = await host.readFile(args.path);
      return content;
    }
  },
  writeFile: {
    description: "Write a file via host bridge",
    parameters: {
      path: { type: "string" },
      content: { type: "string" }
    },
    required: ["path", "content"],
    execute: async (args, host) => {
      await host.writeFile(args.path, args.content);
      return "written";
    }
  }
}`;

// Extension that throws errors
const ERROR_EXTENSION_SOURCE = `{
  fail: {
    description: "Always fails",
    parameters: {},
    execute: async () => { throw new Error("intentional failure"); }
  }
}`;

function makeManifest(
  overrides?: Partial<ExtensionManifest>
): ExtensionManifest {
  return {
    name: "test-ext",
    version: "1.0.0",
    description: "Test extension",
    ...overrides
  };
}

describe("ExtensionManager", () => {
  let manager: ExtensionManager;

  beforeEach(() => {
    manager = new ExtensionManager({ loader: env.LOADER });
  });

  describe("load and discover", () => {
    it("should load an extension and discover its tools", async () => {
      const info = await manager.load(
        makeManifest({ name: "greeter" }),
        GREET_EXTENSION_SOURCE
      );

      expect(info.name).toBe("greeter");
      expect(info.version).toBe("1.0.0");
      expect(info.tools).toEqual(["greeter_greet"]);
    });

    it("should load a multi-tool extension", async () => {
      const info = await manager.load(
        makeManifest({ name: "math" }),
        MULTI_TOOL_SOURCE
      );

      expect(info.tools).toContain("math_add");
      expect(info.tools).toContain("math_multiply");
      expect(info.tools).toHaveLength(2);
    });

    it("should reject duplicate extension names", async () => {
      await manager.load(makeManifest({ name: "dup" }), GREET_EXTENSION_SOURCE);

      await expect(
        manager.load(makeManifest({ name: "dup" }), GREET_EXTENSION_SOURCE)
      ).rejects.toThrow("already loaded");
    });
  });

  describe("unload", () => {
    it("should unload an extension", async () => {
      await manager.load(
        makeManifest({ name: "temp" }),
        GREET_EXTENSION_SOURCE
      );
      expect(manager.list()).toHaveLength(1);

      const removed = await manager.unload("temp");
      expect(removed).toBe(true);
      expect(manager.list()).toHaveLength(0);
    });

    it("should return false for unknown extension", async () => {
      expect(await manager.unload("nonexistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("should list all loaded extensions", async () => {
      await manager.load(
        makeManifest({ name: "ext-a", version: "1.0.0" }),
        GREET_EXTENSION_SOURCE
      );
      await manager.load(
        makeManifest({ name: "ext-b", version: "2.0.0" }),
        MULTI_TOOL_SOURCE
      );

      const list = manager.list();
      expect(list).toHaveLength(2);

      const names = list.map((e) => e.name);
      expect(names).toContain("ext-a");
      expect(names).toContain("ext-b");
    });

    it("should return empty array when no extensions loaded", () => {
      expect(manager.list()).toEqual([]);
    });
  });

  describe("getTools", () => {
    it("should return AI SDK tools from loaded extensions", async () => {
      await manager.load(
        makeManifest({ name: "greeter" }),
        GREET_EXTENSION_SOURCE
      );

      const tools = manager.getTools();
      expect(tools).toHaveProperty("greeter_greet");
    });

    it("should prefix tool names with extension name", async () => {
      await manager.load(makeManifest({ name: "math" }), MULTI_TOOL_SOURCE);

      const tools = manager.getTools();
      expect(Object.keys(tools)).toContain("math_add");
      expect(Object.keys(tools)).toContain("math_multiply");
    });

    it("should merge tools from multiple extensions", async () => {
      await manager.load(
        makeManifest({ name: "greeter" }),
        GREET_EXTENSION_SOURCE
      );
      await manager.load(makeManifest({ name: "math" }), MULTI_TOOL_SOURCE);

      const tools = manager.getTools();
      expect(Object.keys(tools)).toHaveLength(3);
      expect(tools).toHaveProperty("greeter_greet");
      expect(tools).toHaveProperty("math_add");
      expect(tools).toHaveProperty("math_multiply");
    });

    it("should return empty object when no extensions loaded", () => {
      expect(manager.getTools()).toEqual({});
    });
  });

  describe("tool execution", () => {
    it("should execute a simple tool", async () => {
      await manager.load(
        makeManifest({ name: "greeter" }),
        GREET_EXTENSION_SOURCE
      );

      const tools = manager.getTools();
      const greet = tools.greeter_greet;
      const result = await greet.execute!(
        { name: "World" },
        { toolCallId: "tc1", messages: [], abortSignal: undefined as never }
      );

      expect(result).toBe("Hello, World!");
    });

    it("should execute math tools correctly", async () => {
      await manager.load(makeManifest({ name: "math" }), MULTI_TOOL_SOURCE);

      const tools = manager.getTools();

      const sum = await tools.math_add.execute!(
        { a: 3, b: 4 },
        { toolCallId: "tc1", messages: [], abortSignal: undefined as never }
      );
      expect(sum).toBe(7);

      const product = await tools.math_multiply.execute!(
        { a: 5, b: 6 },
        { toolCallId: "tc2", messages: [], abortSignal: undefined as never }
      );
      expect(product).toBe(30);
    });

    it("should propagate tool execution errors", async () => {
      await manager.load(makeManifest({ name: "bad" }), ERROR_EXTENSION_SOURCE);

      const tools = manager.getTools();

      await expect(
        tools.bad_fail.execute!(
          {},
          { toolCallId: "tc1", messages: [], abortSignal: undefined as never }
        )
      ).rejects.toThrow("intentional failure");
    });
  });

  describe("network isolation", () => {
    it("should block network by default (no network permission)", async () => {
      const source = `{
        fetchUrl: {
          description: "Try to fetch a URL",
          parameters: { url: { type: "string" } },
          required: ["url"],
          execute: async (args) => {
            const res = await fetch(args.url);
            return res.status;
          }
        }
      }`;

      await manager.load(
        makeManifest({ name: "fetcher", permissions: {} }),
        source
      );

      const tools = manager.getTools();

      await expect(
        tools.fetcher_fetchUrl.execute!(
          { url: "https://example.com" },
          { toolCallId: "tc1", messages: [], abortSignal: undefined as never }
        )
      ).rejects.toThrow();
    });
  });

  describe("lifecycle after unload", () => {
    it("should not include tools from unloaded extensions", async () => {
      await manager.load(
        makeManifest({ name: "temp" }),
        GREET_EXTENSION_SOURCE
      );
      expect(Object.keys(manager.getTools())).toHaveLength(1);

      await manager.unload("temp");
      expect(Object.keys(manager.getTools())).toHaveLength(0);
    });

    it("should throw when executing a tool from an unloaded extension", async () => {
      await manager.load(
        makeManifest({ name: "temp" }),
        GREET_EXTENSION_SOURCE
      );

      // Capture tools while extension is still loaded
      const tools = manager.getTools();
      expect(tools).toHaveProperty("temp_greet");

      // Unload the extension
      await manager.unload("temp");

      // Executing the captured tool should throw
      await expect(
        tools.temp_greet.execute!(
          { name: "world" },
          { toolCallId: "tc1", messages: [], abortSignal: undefined as never }
        )
      ).rejects.toThrow(/has been unloaded/);
    });

    it("should allow reloading after unload", async () => {
      await manager.load(
        makeManifest({ name: "temp" }),
        GREET_EXTENSION_SOURCE
      );
      await manager.unload("temp");

      const info = await manager.load(
        makeManifest({ name: "temp" }),
        GREET_EXTENSION_SOURCE
      );
      expect(info.tools).toEqual(["temp_greet"]);
    });
  });

  describe("persistence and restore", () => {
    it("should restore extensions from storage after re-creation", async () => {
      // Simulate DO storage with a simple Map-backed mock
      const store = new Map<string, unknown>();
      const mockStorage = {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        delete: async (key: string) => store.delete(key),
        list: async (opts?: { prefix?: string }) => {
          const result = new Map<string, unknown>();
          for (const [k, v] of store) {
            if (!opts?.prefix || k.startsWith(opts.prefix)) {
              result.set(k, v);
            }
          }
          return result;
        }
      } as unknown as DurableObjectStorage;

      // First manager — load an extension
      const manager1 = new ExtensionManager({
        loader: env.LOADER,
        storage: mockStorage
      });
      await manager1.load(makeManifest({ name: "math" }), MULTI_TOOL_SOURCE);
      expect(manager1.list()).toHaveLength(1);

      // Second manager — simulates DO wake from hibernation
      const manager2 = new ExtensionManager({
        loader: env.LOADER,
        storage: mockStorage
      });
      expect(manager2.list()).toHaveLength(0); // empty before restore

      await manager2.restore();
      expect(manager2.list()).toHaveLength(1);
      expect(manager2.list()[0].name).toBe("math");

      // Tools should work after restore
      const tools = manager2.getTools();
      expect(tools).toHaveProperty("math_add");
      const sum = await tools.math_add.execute!(
        { a: 10, b: 20 },
        { toolCallId: "tc1", messages: [], abortSignal: undefined as never }
      );
      expect(sum).toBe(30);
    });

    it("should remove from storage on unload", async () => {
      const store = new Map<string, unknown>();
      const mockStorage = {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        delete: async (key: string) => store.delete(key),
        list: async (opts?: { prefix?: string }) => {
          const result = new Map<string, unknown>();
          for (const [k, v] of store) {
            if (!opts?.prefix || k.startsWith(opts.prefix)) {
              result.set(k, v);
            }
          }
          return result;
        }
      } as unknown as DurableObjectStorage;

      const mgr = new ExtensionManager({
        loader: env.LOADER,
        storage: mockStorage
      });
      await mgr.load(makeManifest({ name: "temp" }), GREET_EXTENSION_SOURCE);
      expect(store.size).toBe(1);

      await mgr.unload("temp");
      expect(store.size).toBe(0);

      // New manager should have nothing to restore
      const mgr2 = new ExtensionManager({
        loader: env.LOADER,
        storage: mockStorage
      });
      await mgr2.restore();
      expect(mgr2.list()).toHaveLength(0);
    });

    it("restore should be idempotent", async () => {
      const store = new Map<string, unknown>();
      const mockStorage = {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        delete: async (key: string) => store.delete(key),
        list: async (opts?: { prefix?: string }) => {
          const result = new Map<string, unknown>();
          for (const [k, v] of store) {
            if (!opts?.prefix || k.startsWith(opts.prefix)) {
              result.set(k, v);
            }
          }
          return result;
        }
      } as unknown as DurableObjectStorage;

      const mgr = new ExtensionManager({
        loader: env.LOADER,
        storage: mockStorage
      });
      await mgr.load(makeManifest({ name: "greeter" }), GREET_EXTENSION_SOURCE);

      const mgr2 = new ExtensionManager({
        loader: env.LOADER,
        storage: mockStorage
      });
      await mgr2.restore();
      await mgr2.restore(); // second call should be a no-op
      expect(mgr2.list()).toHaveLength(1);
    });
  });

  describe("name sanitization", () => {
    it("should sanitize hyphens in extension names for tool names", async () => {
      const info = await manager.load(
        makeManifest({ name: "my-cool-ext" }),
        GREET_EXTENSION_SOURCE
      );

      // ExtensionInfo.tools should have sanitized prefix
      expect(info.tools).toEqual(["my_cool_ext_greet"]);

      // getTools() should use sanitized prefix
      const tools = manager.getTools();
      expect(tools).toHaveProperty("my_cool_ext_greet");
      expect(tools).not.toHaveProperty("my-cool-ext_greet");
    });

    it("sanitizeName should replace non-alphanumeric chars", () => {
      expect(sanitizeName("hello-world")).toBe("hello_world");
      expect(sanitizeName("foo.bar.baz")).toBe("foo_bar_baz");
      expect(sanitizeName("a--b")).toBe("a_b");
      expect(sanitizeName("simple")).toBe("simple");
      expect(sanitizeName("with spaces")).toBe("with_spaces");
    });
  });
});
