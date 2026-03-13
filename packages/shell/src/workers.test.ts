import { describe, expect, it, vi } from "vitest";
import {
  DOSqlExecutor,
  D1SqlExecutor,
  DynamicIsolateExecutor,
  WorkersAIMarkdownConverter
} from "./workers";
import type {
  DOSqlStorageLike,
  DOSqlCursorLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  WorkerLoaderLike,
  AiBindingLike
} from "./workers";

// ── DOSqlExecutor ──────────────────────────────────────────────

describe("DOSqlExecutor", () => {
  function createMockStorage(
    rows: Record<string, unknown>[],
    columnNames: string[],
    rowsWritten = 0
  ): DOSqlStorageLike {
    return {
      exec: vi.fn().mockReturnValue({
        columnNames,
        rowsRead: rows.length,
        rowsWritten,
        toArray: () => rows,
        [Symbol.iterator]: function* () {
          yield* rows;
        }
      } satisfies DOSqlCursorLike)
    };
  }

  describe("query", () => {
    it("should return columns and values from SELECT", async () => {
      const storage = createMockStorage(
        [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" }
        ],
        ["id", "name"]
      );
      const executor = new DOSqlExecutor(storage);
      const result = await executor.query("SELECT * FROM users");

      expect(result.columns).toEqual(["id", "name"]);
      expect(result.values).toEqual([
        [1, "Alice"],
        [2, "Bob"]
      ]);
      expect(storage.exec).toHaveBeenCalledWith("SELECT * FROM users");
    });

    it("should return empty results for no rows", async () => {
      const storage = createMockStorage([], ["id", "name"]);
      const executor = new DOSqlExecutor(storage);
      const result = await executor.query("SELECT * FROM empty");

      expect(result.columns).toEqual(["id", "name"]);
      expect(result.values).toEqual([]);
    });

    it("should handle single column results", async () => {
      const storage = createMockStorage([{ count: 42 }], ["count"]);
      const executor = new DOSqlExecutor(storage);
      const result = await executor.query("SELECT COUNT(*) as count FROM t");

      expect(result.columns).toEqual(["count"]);
      expect(result.values).toEqual([[42]]);
    });

    it("should handle null values", async () => {
      const storage = createMockStorage(
        [{ id: 1, email: null }],
        ["id", "email"]
      );
      const executor = new DOSqlExecutor(storage);
      const result = await executor.query("SELECT id, email FROM users");

      expect(result.values).toEqual([[1, null]]);
    });
  });

  describe("run", () => {
    it("should return changes count for INSERT", async () => {
      const storage = createMockStorage([], [], 1);
      const executor = new DOSqlExecutor(storage);
      const result = await executor.run(
        "INSERT INTO users (name) VALUES ('Alice')"
      );

      expect(result.changes).toBe(1);
      expect(storage.exec).toHaveBeenCalledWith(
        "INSERT INTO users (name) VALUES ('Alice')"
      );
    });

    it("should return changes count for UPDATE", async () => {
      const storage = createMockStorage([], [], 3);
      const executor = new DOSqlExecutor(storage);
      const result = await executor.run("UPDATE users SET active = 1");

      expect(result.changes).toBe(3);
    });

    it("should return 0 changes for no-op", async () => {
      const storage = createMockStorage([], [], 0);
      const executor = new DOSqlExecutor(storage);
      const result = await executor.run("DELETE FROM users WHERE id = 999");

      expect(result.changes).toBe(0);
    });
  });
});

// ── D1SqlExecutor ───────────────────────────────────────────────────

describe("D1SqlExecutor", () => {
  function createMockD1(
    rows: Record<string, unknown>[] | undefined,
    success = true,
    changes?: number
  ): D1DatabaseLike {
    return {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ success, results: rows }),
        run: vi.fn().mockResolvedValue({
          success,
          meta: changes !== undefined ? { changes } : undefined
        })
      } satisfies D1PreparedStatementLike)
    };
  }

  describe("query", () => {
    it("should return columns and values from SELECT", async () => {
      const db = createMockD1([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" }
      ]);
      const executor = new D1SqlExecutor(db);
      const result = await executor.query("SELECT * FROM users");

      expect(result.columns).toEqual(["id", "name"]);
      expect(result.values).toEqual([
        [1, "Alice"],
        [2, "Bob"]
      ]);
      expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM users");
    });

    it("should return empty results for no rows", async () => {
      const db = createMockD1([]);
      const executor = new D1SqlExecutor(db);
      const result = await executor.query("SELECT * FROM empty");

      expect(result.columns).toEqual([]);
      expect(result.values).toEqual([]);
    });

    it("should return empty results when success is false", async () => {
      const db = createMockD1(undefined, false);
      const executor = new D1SqlExecutor(db);
      const result = await executor.query("SELECT * FROM users");

      expect(result.columns).toEqual([]);
      expect(result.values).toEqual([]);
    });

    it("should handle single column results", async () => {
      const db = createMockD1([{ count: 42 }]);
      const executor = new D1SqlExecutor(db);
      const result = await executor.query("SELECT COUNT(*) as count FROM t");

      expect(result.columns).toEqual(["count"]);
      expect(result.values).toEqual([[42]]);
    });

    it("should handle null values", async () => {
      const db = createMockD1([{ id: 1, email: null }]);
      const executor = new D1SqlExecutor(db);
      const result = await executor.query("SELECT id, email FROM users");

      expect(result.values).toEqual([[1, null]]);
    });
  });

  describe("run", () => {
    it("should return changes count for INSERT", async () => {
      const db = createMockD1([], true, 1);
      const executor = new D1SqlExecutor(db);
      const result = await executor.run(
        "INSERT INTO users (name) VALUES ('Alice')"
      );

      expect(result.changes).toBe(1);
      expect(db.prepare).toHaveBeenCalledWith(
        "INSERT INTO users (name) VALUES ('Alice')"
      );
    });

    it("should return changes count for UPDATE", async () => {
      const db = createMockD1([], true, 3);
      const executor = new D1SqlExecutor(db);
      const result = await executor.run("UPDATE users SET active = 1");

      expect(result.changes).toBe(3);
    });

    it("should return 0 changes when meta is undefined", async () => {
      const db = createMockD1([], true, undefined);
      const executor = new D1SqlExecutor(db);
      const result = await executor.run("DELETE FROM users WHERE id = 999");

      expect(result.changes).toBe(0);
    });
  });
});

// ── DynamicIsolateExecutor ──────────────────────────────────────────

describe("DynamicIsolateExecutor", () => {
  function createMockLoader(response: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }): { loader: WorkerLoaderLike; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    const loader: WorkerLoaderLike = {
      get: vi.fn().mockReturnValue({
        getEntrypoint: vi.fn().mockReturnValue({ fetch: fetchMock })
      })
    };
    return { loader, fetchMock };
  }

  it("should load a worker via loader.get and call fetch()", async () => {
    const { loader, fetchMock } = createMockLoader({
      stdout: "2\n",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    const result = await executor.execute("console.log(1+1)", "javascript");

    expect(loader.get).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stdout).toBe("2\n");
    expect(result.exitCode).toBe(0);
  });

  it("should embed user code in the module passed to loader.get", async () => {
    const { loader } = createMockLoader({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    await executor.execute("console.log('hello')", "javascript");

    const getCall = (loader.get as ReturnType<typeof vi.fn>).mock.calls[0];
    const codeCallback = getCall[1];
    const workerCode = codeCallback();
    expect(workerCode.mainModule).toBe("code.js");
    expect(workerCode.modules["code.js"]).toContain("console.log('hello')");
    expect(workerCode.modules["code.js"]).toContain("export default");
  });

  it("should embed env and stdin in the module for javascript", async () => {
    const { loader } = createMockLoader({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    await executor.execute("1", "javascript", {
      stdin: "input data",
      env: { HOME: "/root" }
    });

    const getCall = (loader.get as ReturnType<typeof vi.fn>).mock.calls[0];
    const workerCode = getCall[1]();
    const code = workerCode.modules["code.js"] as string;
    expect(code).toContain('"HOME"');
    expect(code).toContain('"/root"');
    expect(code).toContain('"input data"');
  });

  it("should return error result for unsupported language", async () => {
    const { loader } = createMockLoader({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    const result = await executor.execute(
      "code",
      "ruby" as "javascript",
      undefined
    );

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("Unsupported language");
    expect(loader.get).not.toHaveBeenCalled();
  });

  it("should set globalOutbound to null by default", async () => {
    const { loader } = createMockLoader({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    await executor.execute("1", "javascript");

    const getCall = (loader.get as ReturnType<typeof vi.fn>).mock.calls[0];
    const workerCode = getCall[1]();
    expect(workerCode.globalOutbound).toBeNull();
  });

  it("should use a unique id per execution", async () => {
    const { loader } = createMockLoader({
      stdout: "",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    await executor.execute("1", "javascript");
    await executor.execute("2", "javascript");

    const calls = (loader.get as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).not.toBe(calls[1][0]);
  });

  it("should generate python module with user_code.py", async () => {
    const { loader } = createMockLoader({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0
    });
    const executor = new DynamicIsolateExecutor({ loader });

    await executor.execute("print('hello')", "python");

    const getCall = (loader.get as ReturnType<typeof vi.fn>).mock.calls[0];
    const workerCode = getCall[1]();
    expect(workerCode.mainModule).toBe("runner.js");
    expect(workerCode.modules["runner.js"]).toContain("export default");
    expect(workerCode.modules["user_code.py"]).toBe("print('hello')");
  });
});

// ── WorkersAIMarkdownConverter ──────────────────────────────────────

describe("WorkersAIMarkdownConverter", () => {
  function createMockAi(response: unknown): AiBindingLike {
    return {
      run: vi.fn().mockResolvedValue(response)
    };
  }

  describe("convert with string input", () => {
    it("should pass string content to AI model", async () => {
      const ai = createMockAi("# Hello");
      const converter = new WorkersAIMarkdownConverter(ai);
      const result = await converter.convert("<h1>Hello</h1>");

      expect(ai.run).toHaveBeenCalledWith(
        "@cf/extractous/document-to-markdown",
        { content: "<h1>Hello</h1>" }
      );
      expect(result).toBe("# Hello");
    });

    it("should pass url option", async () => {
      const ai = createMockAi("# Page");
      const converter = new WorkersAIMarkdownConverter(ai);
      await converter.convert("<h1>Page</h1>", {
        url: "https://example.com"
      });

      expect(ai.run).toHaveBeenCalledWith(
        "@cf/extractous/document-to-markdown",
        {
          content: "<h1>Page</h1>",
          url: "https://example.com"
        }
      );
    });

    it("should pass type option", async () => {
      const ai = createMockAi("content");
      const converter = new WorkersAIMarkdownConverter(ai);
      await converter.convert("<p>test</p>", { type: "text/html" });

      expect(ai.run).toHaveBeenCalledWith(
        "@cf/extractous/document-to-markdown",
        {
          content: "<p>test</p>",
          type: "text/html"
        }
      );
    });
  });

  describe("convert with binary input", () => {
    it("should pass Uint8Array as file array", async () => {
      const ai = createMockAi("# PDF Content");
      const converter = new WorkersAIMarkdownConverter(ai);
      const binary = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const result = await converter.convert(binary);

      expect(ai.run).toHaveBeenCalledWith(
        "@cf/extractous/document-to-markdown",
        { file: [0x25, 0x50, 0x44, 0x46] }
      );
      expect(result).toBe("# PDF Content");
    });
  });

  describe("custom model", () => {
    it("should use custom model when specified", async () => {
      const ai = createMockAi("result");
      const converter = new WorkersAIMarkdownConverter(ai, {
        model: "@cf/custom-model"
      });
      await converter.convert("input");

      expect(ai.run).toHaveBeenCalledWith("@cf/custom-model", {
        content: "input"
      });
    });

    it("should use default model when not specified", async () => {
      const ai = createMockAi("result");
      const converter = new WorkersAIMarkdownConverter(ai);
      await converter.convert("input");

      expect(ai.run).toHaveBeenCalledWith(
        "@cf/extractous/document-to-markdown",
        { content: "input" }
      );
    });
  });

  describe("response parsing", () => {
    it("should handle string response", async () => {
      const ai = createMockAi("direct string");
      const converter = new WorkersAIMarkdownConverter(ai);
      expect(await converter.convert("x")).toBe("direct string");
    });

    it("should handle { response } object", async () => {
      const ai = createMockAi({ response: "from response field" });
      const converter = new WorkersAIMarkdownConverter(ai);
      expect(await converter.convert("x")).toBe("from response field");
    });

    it("should handle { text } object", async () => {
      const ai = createMockAi({ text: "from text field" });
      const converter = new WorkersAIMarkdownConverter(ai);
      expect(await converter.convert("x")).toBe("from text field");
    });

    it("should stringify other response types", async () => {
      const ai = createMockAi(42);
      const converter = new WorkersAIMarkdownConverter(ai);
      expect(await converter.convert("x")).toBe("42");
    });

    it("should prefer response field over text field", async () => {
      const ai = createMockAi({ response: "resp", text: "txt" });
      const converter = new WorkersAIMarkdownConverter(ai);
      expect(await converter.convert("x")).toBe("resp");
    });
  });
});
