import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  InMemoryFileSystem,
  DurableObjectKVFileSystem,
  DurableObjectRawFileSystem
} from "../file-system";

// ── InMemoryFileSystem ───────────────────────────────────────────────

describe("InMemoryFileSystem", () => {
  it("read returns null for a missing path", () => {
    const fs = new InMemoryFileSystem();
    expect(fs.read("index.ts")).toBeNull();
  });

  it("can be seeded from a plain object", () => {
    const fs = new InMemoryFileSystem({ "index.ts": "export default 1" });
    expect(fs.read("index.ts")).toBe("export default 1");
  });

  it("can be seeded from a Map", () => {
    const fs = new InMemoryFileSystem(
      new Map([["index.ts", "export default 1"]])
    );
    expect(fs.read("index.ts")).toBe("export default 1");
  });

  it("write then read returns the written content", () => {
    const fs = new InMemoryFileSystem();
    fs.write("foo.ts", "const x = 1");
    expect(fs.read("foo.ts")).toBe("const x = 1");
  });

  it("write overwrites existing content", () => {
    const fs = new InMemoryFileSystem({ "foo.ts": "v1" });
    fs.write("foo.ts", "v2");
    expect(fs.read("foo.ts")).toBe("v2");
  });

  it("writes to different paths are independent", () => {
    const fs = new InMemoryFileSystem();
    fs.write("a.ts", "aaa");
    fs.write("b.ts", "bbb");
    expect(fs.read("a.ts")).toBe("aaa");
    expect(fs.read("b.ts")).toBe("bbb");
    expect(fs.read("c.ts")).toBeNull();
  });

  it("flush is a no-op that resolves immediately", async () => {
    const fs = new InMemoryFileSystem();
    fs.write("foo.ts", "content");
    await expect(fs.flush()).resolves.toBeUndefined();
    // State is preserved after flush
    expect(fs.read("foo.ts")).toBe("content");
  });
});

// ── DurableObjectKVFileSystem ────────────────────────────────────────

// Each test gets its own uniquely-named DO instance so that direct KV writes
// in one test cannot contaminate another. DO storage is backed by an in-memory
// SQLite database that persists across runInDurableObject calls within the same
// test run, so sharing an ID across tests would cause cross-test interference.
function makeStub(id: string) {
  return env.FS_TEST.get(env.FS_TEST.idFromName(id));
}

describe("DurableObjectKVFileSystem", () => {
  it("read returns null for a missing path", async () => {
    await runInDurableObject(
      makeStub("read-null"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);
        expect(fs.read("index.ts")).toBeNull();
      }
    );
  });

  it("write then read returns the written content from the overlay", async () => {
    await runInDurableObject(
      makeStub("write-read"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);
        fs.write("index.ts", "export default 1");
        expect(fs.read("index.ts")).toBe("export default 1");
      }
    );
  });

  it("write does not immediately persist to KV — flush is required", async () => {
    await runInDurableObject(
      makeStub("write-no-persist"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);
        fs.write("index.ts", "export default 1");
        // Key should not be in KV yet (still buffered in the overlay)
        expect(state.storage.kv.get("bundle/index.ts")).toBeUndefined();
      }
    );
  });

  it("flush writes all overlay entries to KV", async () => {
    await runInDurableObject(
      makeStub("flush-writes"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);
        fs.write("a.ts", "aaa");
        fs.write("b.ts", "bbb");
        await fs.flush();
        expect(state.storage.kv.get<string>("bundle/a.ts")).toBe("aaa");
        expect(state.storage.kv.get<string>("bundle/b.ts")).toBe("bbb");
      }
    );
  });

  it("flush clears the overlay so subsequent reads fall back to KV", async () => {
    await runInDurableObject(
      makeStub("flush-clears"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);
        fs.write("index.ts", "v1");
        await fs.flush();
        // Update KV directly to "v2" — the overlay is gone, so fs must read from KV
        state.storage.kv.put("bundle/index.ts", "v2");
        expect(fs.read("index.ts")).toBe("v2");
      }
    );
  });

  it("read falls back to KV when the path is not in the overlay", async () => {
    await runInDurableObject(
      makeStub("read-kv-fallback"),
      async (_instance, state) => {
        // Write directly to KV, bypassing the overlay
        state.storage.kv.put("bundle/index.ts", "from-kv");
        const fs = new DurableObjectKVFileSystem(state.storage);
        expect(fs.read("index.ts")).toBe("from-kv");
      }
    );
  });

  it("overlay shadows KV — overlay value wins before flush", async () => {
    await runInDurableObject(
      makeStub("overlay-shadows"),
      async (_instance, state) => {
        // Seed KV with an old value
        state.storage.kv.put("bundle/index.ts", "old");
        const fs = new DurableObjectKVFileSystem(state.storage);
        // Write a newer value into the overlay
        fs.write("index.ts", "new");
        expect(fs.read("index.ts")).toBe("new");
      }
    );
  });

  it("custom prefix is applied to KV keys", async () => {
    await runInDurableObject(
      makeStub("custom-prefix"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage, "src/");
        fs.write("index.ts", "content");
        await fs.flush();
        // Key should use the custom prefix, not the default "bundle/"
        expect(state.storage.kv.get<string>("src/index.ts")).toBe("content");
        expect(state.storage.kv.get("bundle/index.ts")).toBeUndefined();
      }
    );
  });
});

// ── DurableObjectRawFileSystem ───────────────────────────────────────

describe("DurableObjectRawFileSystem", () => {
  it("read returns null for a missing path", async () => {
    await runInDurableObject(
      makeStub("raw-read-null"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage);
        expect(fs.read("index.ts")).toBeNull();
      }
    );
  });

  it("write persists immediately to KV without a flush", async () => {
    await runInDurableObject(
      makeStub("raw-write-immediate"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage);
        fs.write("index.ts", "hello");
        // Unlike DurableObjectKVFileSystem, no flush() is needed
        expect(state.storage.kv.get<string>("bundle/index.ts")).toBe("hello");
      }
    );
  });

  it("read returns content written via write", async () => {
    await runInDurableObject(
      makeStub("raw-write-read"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage);
        fs.write("index.ts", "content");
        expect(fs.read("index.ts")).toBe("content");
      }
    );
  });

  it("flush is a no-op", async () => {
    await runInDurableObject(
      makeStub("raw-flush-noop"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage);
        fs.write("index.ts", "content");
        await expect(fs.flush()).resolves.toBeUndefined();
        expect(fs.read("index.ts")).toBe("content");
      }
    );
  });

  it("custom prefix is applied to KV keys", async () => {
    await runInDurableObject(
      makeStub("raw-custom-prefix"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage, "src/");
        fs.write("index.ts", "content");
        expect(state.storage.kv.get<string>("src/index.ts")).toBe("content");
        expect(state.storage.kv.get("bundle/index.ts")).toBeUndefined();
      }
    );
  });
});
