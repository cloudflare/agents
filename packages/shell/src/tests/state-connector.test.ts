import { describe, expect, it } from "vitest";
import { STATE_METHOD_NAMES } from "../backend";
import { StateConnector, stateConnector } from "../connector";
import { createMemoryStateBackend } from "../memory";
import { STATE_TYPES } from "../prompt";
import { STATE_METHODS, objectArgsToPositional } from "../state-methods";
import { stateToolsFromBackend } from "../workers";

const fakeCtx = {} as ExecutionContext;

function connector(): StateConnector {
  return stateConnector(fakeCtx, createMemoryStateBackend());
}

// ── Drift guards ───────────────────────────────────────────────────────
// Adding a method to StateBackend must fail loudly until the param table,
// the connector tools, and the sandbox types all know about it.

describe("drift guards", () => {
  it("every StateBackend method has a param-table entry", () => {
    for (const method of STATE_METHOD_NAMES) {
      expect(STATE_METHODS[method], `STATE_METHODS.${method}`).toBeDefined();
    }
    expect(Object.keys(STATE_METHODS).sort()).toEqual(
      [...STATE_METHOD_NAMES].sort()
    );
  });

  it("every StateBackend method has a connector tool", async () => {
    const { descriptors } = await connector().describe();
    for (const method of STATE_METHOD_NAMES) {
      expect(descriptors[method], `tool for ${method}`).toBeDefined();
    }
  });

  it("every StateBackend method appears in STATE_TYPES with object args", () => {
    for (const method of STATE_METHOD_NAMES) {
      const spec = STATE_METHODS[method];
      if (spec.params.length === 0) {
        expect(STATE_TYPES).toContain(`${method}()`);
      } else {
        expect(STATE_TYPES, `${method} signature`).toContain(
          `${method}(args: {`
        );
      }
    }
  });
});

// ── Replay policy ──────────────────────────────────────────────────────

describe("replay policy", () => {
  it("marks every read as replay: reexecute and leaves writes logged", async () => {
    const { annotations = {} } = await connector().describe();
    for (const method of STATE_METHOD_NAMES) {
      const spec = STATE_METHODS[method];
      if (spec.kind === "read") {
        expect(annotations[method]?.replay, `${method} should reexecute`).toBe(
          "reexecute"
        );
      } else {
        expect(
          annotations[method]?.replay,
          `${method} should be logged`
        ).toBeUndefined();
      }
      expect(annotations[method]?.requiresApproval).toBeUndefined();
    }
  });
});

// ── Object → positional mapping ────────────────────────────────────────

describe("object args", () => {
  it("maps object args to positional backend calls", async () => {
    const c = connector();
    await c.executeTool("writeFile", {
      path: "/notes.txt",
      content: "hello"
    });
    expect(await c.executeTool("readFile", { path: "/notes.txt" })).toBe(
      "hello"
    );

    await c.executeTool("replaceInFile", {
      path: "/notes.txt",
      search: "hello",
      replacement: "bye"
    });
    expect(await c.executeTool("readFile", { path: "/notes.txt" })).toBe("bye");
  });

  it("passes option bags through in position", async () => {
    const c = connector();
    await c.executeTool("writeJson", {
      path: "/config.json",
      value: { a: 1 },
      options: { spaces: 2 }
    });
    expect(await c.executeTool("readFile", { path: "/config.json" })).toBe(
      `${JSON.stringify({ a: 1 }, null, 2)}\n`
    );
  });

  it("rejects positional calls with an actionable message", async () => {
    await expect(
      connector().executeTool("readFile", "/notes.txt")
    ).rejects.toThrow(/state\.readFile\(\{ path \}\)/);
  });

  it("names the missing required parameter", async () => {
    await expect(
      connector().executeTool("writeFile", { path: "/x.txt" })
    ).rejects.toThrow(/missing required parameter "content"/);
  });

  it("trims trailing optional parameters", () => {
    expect(objectArgsToPositional("mkdir", { path: "/dir" })).toEqual(["/dir"]);
    expect(
      objectArgsToPositional("mkdir", {
        path: "/dir",
        options: { recursive: true }
      })
    ).toEqual(["/dir", { recursive: true }]);
  });
});

// ── Binary flow ────────────────────────────────────────────────────────

describe("binary", () => {
  it("round-trips bytes through object args", async () => {
    const c = connector();
    const bytes = new Uint8Array([1, 2, 3, 255]);
    await c.executeTool("writeFileBytes", { path: "/bin", content: bytes });
    const out = (await c.executeTool("readFileBytes", {
      path: "/bin"
    })) as Uint8Array;
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([1, 2, 3, 255]);
  });
});

// ── Sandbox surface ────────────────────────────────────────────────────

describe("connector surface", () => {
  it("is named state and serves STATE_TYPES", async () => {
    const c = connector();
    expect(c.name()).toBe("state");
    expect(await c.getTypeScriptTypes()).toBe(STATE_TYPES);
    expect(STATE_TYPES).toContain("declare const state");
  });
});

// ── Legacy ToolProvider compatibility ──────────────────────────────────

describe("stateToolsFromBackend", () => {
  it("accepts both object-args and positional calls", async () => {
    const provider = stateToolsFromBackend(createMemoryStateBackend());
    const tools = provider.tools as Record<
      string,
      { execute: (...args: unknown[]) => Promise<unknown> }
    >;

    await tools.writeFile.execute({ path: "/a.txt", content: "object" });
    expect(await tools.readFile.execute({ path: "/a.txt" })).toBe("object");

    await tools.writeFile.execute("/b.txt", "positional");
    expect(await tools.readFile.execute("/b.txt")).toBe("positional");
  });

  it("keeps positional semantics for plan-shaped first arguments", async () => {
    const provider = stateToolsFromBackend(createMemoryStateBackend());
    const tools = provider.tools as Record<
      string,
      { execute: (...args: unknown[]) => Promise<unknown> }
    >;

    // applyEditPlan's positional first arg is an object — its keys are not
    // parameter names, so it must NOT be mistaken for an object-args call.
    const plan = await tools.planEdits.execute([
      { kind: "write", path: "/c.txt", content: "planned" }
    ]);
    await tools.applyEditPlan.execute(plan);
    expect(await tools.readFile.execute("/c.txt")).toBe("planned");
  });
});
