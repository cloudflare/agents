import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  InMemoryFileSystem,
  OverlayFileSystem,
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

  it("delete removes existing content", () => {
    const fs = new InMemoryFileSystem({ "foo.ts": "content" });
    fs.delete("foo.ts");
    expect(fs.read("foo.ts")).toBeNull();
    expect(fs.list()).toEqual([]);
  });

  it("delete is a no-op for a missing path", () => {
    const fs = new InMemoryFileSystem();
    fs.delete("missing.ts");
    expect(fs.read("missing.ts")).toBeNull();
    expect(fs.list()).toEqual([]);
  });

  it("writes to different paths are independent", () => {
    const fs = new InMemoryFileSystem();
    fs.write("a.ts", "aaa");
    fs.write("b.ts", "bbb");
    expect(fs.read("a.ts")).toBe("aaa");
    expect(fs.read("b.ts")).toBe("bbb");
    expect(fs.read("c.ts")).toBeNull();
  });

  it("list returns all paths", () => {
    const fs = new InMemoryFileSystem({
      "src/index.ts": "",
      "src/utils.ts": "",
      "README.md": ""
    });
    expect(fs.list().sort()).toEqual([
      "README.md",
      "src/index.ts",
      "src/utils.ts"
    ]);
  });

  it("list filters by prefix", () => {
    const fs = new InMemoryFileSystem({
      "src/index.ts": "",
      "src/utils.ts": "",
      "README.md": ""
    });
    expect(fs.list("src/").sort()).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  it("list returns empty array when nothing matches", () => {
    const fs = new InMemoryFileSystem({ "src/index.ts": "" });
    expect(fs.list("lib/")).toEqual([]);
  });

  it("flush is a no-op that resolves immediately", async () => {
    const fs = new InMemoryFileSystem();
    fs.write("foo.ts", "content");
    await expect(fs.flush()).resolves.toBeUndefined();
    // State is preserved after flush
    expect(fs.read("foo.ts")).toBe("content");
  });
});

// ── OverlayFileSystem ────────────────────────────────────────────────

describe("OverlayFileSystem", () => {
  it("delete hides inner files before flush", () => {
    const inner = new InMemoryFileSystem({ "index.ts": "persisted" });
    const fs = new OverlayFileSystem(inner);

    fs.delete("index.ts");

    expect(fs.read("index.ts")).toBeNull();
    expect(fs.list()).toEqual([]);
    expect(inner.read("index.ts")).toBe("persisted");
  });

  it("flush persists deletes to the inner filesystem", async () => {
    const inner = new InMemoryFileSystem({ "index.ts": "persisted" });
    const fs = new OverlayFileSystem(inner);

    fs.delete("index.ts");
    await fs.flush();

    expect(inner.read("index.ts")).toBeNull();
    expect(inner.list()).toEqual([]);
  });

  it("delete removes pending overlay writes", () => {
    const inner = new InMemoryFileSystem();
    const fs = new OverlayFileSystem(inner);

    fs.write("index.ts", "new");
    fs.delete("index.ts");

    expect(fs.read("index.ts")).toBeNull();
    expect(fs.list()).toEqual([]);
  });

  it("write after delete restores the file", () => {
    const inner = new InMemoryFileSystem({ "index.ts": "persisted" });
    const fs = new OverlayFileSystem(inner);

    fs.delete("index.ts");
    fs.write("index.ts", "replacement");

    expect(fs.read("index.ts")).toBe("replacement");
    expect(fs.list()).toEqual(["index.ts"]);
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

  it("delete hides persisted KV entries before flush", async () => {
    await runInDurableObject(
      makeStub("delete-hides-persisted"),
      async (_instance, state) => {
        state.storage.kv.put("bundle/index.ts", "persisted");
        const fs = new DurableObjectKVFileSystem(state.storage);

        fs.delete("index.ts");

        expect(fs.read("index.ts")).toBeNull();
        expect(fs.list()).toEqual([]);
        expect(state.storage.kv.get<string>("bundle/index.ts")).toBe(
          "persisted"
        );
      }
    );
  });

  it("flush persists deletes to KV", async () => {
    await runInDurableObject(
      makeStub("delete-flushes"),
      async (_instance, state) => {
        state.storage.kv.put("bundle/index.ts", "persisted");
        const fs = new DurableObjectKVFileSystem(state.storage);

        fs.delete("index.ts");
        await fs.flush();

        expect(state.storage.kv.get("bundle/index.ts")).toBeUndefined();
        expect(fs.read("index.ts")).toBeNull();
      }
    );
  });

  it("delete removes pending overlay writes before flush", async () => {
    await runInDurableObject(
      makeStub("delete-overlay-write"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);

        fs.write("index.ts", "new");
        fs.delete("index.ts");
        await fs.flush();

        expect(state.storage.kv.get("bundle/index.ts")).toBeUndefined();
        expect(fs.read("index.ts")).toBeNull();
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

  it("list returns overlay entries before flush", async () => {
    await runInDurableObject(
      makeStub("kv-list-overlay"),
      async (_instance, state) => {
        const fs = new DurableObjectKVFileSystem(state.storage);
        fs.write("src/index.ts", "");
        fs.write("src/utils.ts", "");
        expect(fs.list("src/").sort()).toEqual([
          "src/index.ts",
          "src/utils.ts"
        ]);
      }
    );
  });

  it("list merges overlay and persisted KV entries after partial flush", async () => {
    await runInDurableObject(
      makeStub("kv-list-merge"),
      async (_instance, state) => {
        // Persist one file to KV
        state.storage.kv.put("bundle/persisted.ts", "");
        const fs = new DurableObjectKVFileSystem(state.storage);
        // Add a new file via the overlay (not yet flushed)
        fs.write("overlay.ts", "");
        const paths = fs.list().sort();
        expect(paths).toContain("persisted.ts");
        expect(paths).toContain("overlay.ts");
      }
    );
  });

  it("list deduplicates paths that exist in both overlay and KV", async () => {
    await runInDurableObject(
      makeStub("kv-list-dedup"),
      async (_instance, state) => {
        // Seed KV with a file
        state.storage.kv.put("bundle/index.ts", "old");
        const fs = new DurableObjectKVFileSystem(state.storage);
        // Write to overlay — same path should only appear once in list()
        fs.write("index.ts", "new");
        expect(fs.list()).toEqual(["index.ts"]);
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

  it("delete removes content immediately from KV", async () => {
    await runInDurableObject(
      makeStub("raw-delete"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage);
        fs.write("index.ts", "content");

        fs.delete("index.ts");

        expect(fs.read("index.ts")).toBeNull();
        expect(state.storage.kv.get("bundle/index.ts")).toBeUndefined();
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

  it("list returns logical paths (without storage prefix)", async () => {
    await runInDurableObject(makeStub("raw-list"), async (_instance, state) => {
      const fs = new DurableObjectRawFileSystem(state.storage);
      fs.write("src/index.ts", "");
      fs.write("src/utils.ts", "");
      fs.write("README.md", "");
      expect(fs.list().sort()).toEqual([
        "README.md",
        "src/index.ts",
        "src/utils.ts"
      ]);
    });
  });

  it("list filters by prefix", async () => {
    await runInDurableObject(
      makeStub("raw-list-prefix"),
      async (_instance, state) => {
        const fs = new DurableObjectRawFileSystem(state.storage);
        fs.write("src/index.ts", "");
        fs.write("src/utils.ts", "");
        fs.write("README.md", "");
        expect(fs.list("src/").sort()).toEqual([
          "src/index.ts",
          "src/utils.ts"
        ]);
      }
    );
  });
});
