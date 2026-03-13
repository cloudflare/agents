import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  BetterSqlite3Executor,
  ChildProcessExecutor,
  TurndownConverter
} from "./node";
import { Bash } from "./Shell";

// Helper to strip ANSI color codes (for when FORCE_COLOR is set)
const stripAnsi = (s: string) =>
  s.replace(new RegExp(String.fromCharCode(27) + "\\[\\d+m", "g"), "");

// ── BetterSqlite3Executor ─────────────────────────────────────────

describe("BetterSqlite3Executor", () => {
  function createExecutor() {
    const db = new Database(":memory:");
    return { executor: new BetterSqlite3Executor(db), db };
  }

  it("should create table and insert rows", async () => {
    const { executor } = createExecutor();
    await executor.run(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"
    );
    const result = await executor.run(
      "INSERT INTO users (name) VALUES ('Alice')"
    );
    expect(result.changes).toBe(1);
  });

  it("should query rows", async () => {
    const { executor } = createExecutor();
    await executor.run("CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)");
    await executor.run("INSERT INTO items (val) VALUES ('a')");
    await executor.run("INSERT INTO items (val) VALUES ('b')");

    const result = await executor.query(
      "SELECT id, val FROM items ORDER BY id"
    );
    expect(result.columns).toEqual(["id", "val"]);
    expect(result.values).toEqual([
      [1, "a"],
      [2, "b"]
    ]);
  });

  it("should handle NULL values", async () => {
    const { executor } = createExecutor();
    await executor.run("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    await executor.run("INSERT INTO t (val) VALUES (NULL)");

    const result = await executor.query("SELECT val FROM t");
    expect(result.values).toEqual([[null]]);
  });

  it("should handle empty result sets", async () => {
    const { executor } = createExecutor();
    await executor.run("CREATE TABLE empty (id INTEGER PRIMARY KEY)");

    const result = await executor.query("SELECT * FROM empty");
    expect(result.columns).toEqual(["id"]);
    expect(result.values).toEqual([]);
  });

  it("should return correct changes count for UPDATE", async () => {
    const { executor } = createExecutor();
    await executor.run("CREATE TABLE nums (id INTEGER PRIMARY KEY, n INTEGER)");
    await executor.run("INSERT INTO nums (n) VALUES (1)");
    await executor.run("INSERT INTO nums (n) VALUES (2)");
    await executor.run("INSERT INTO nums (n) VALUES (3)");

    const result = await executor.run("UPDATE nums SET n = n + 10 WHERE n > 1");
    expect(result.changes).toBe(2);
  });

  it("should return 0 changes for no-op DELETE", async () => {
    const { executor } = createExecutor();
    await executor.run("CREATE TABLE t2 (id INTEGER PRIMARY KEY)");
    const result = await executor.run("DELETE FROM t2 WHERE id = 999");
    expect(result.changes).toBe(0);
  });

  it("should support multiple data types", async () => {
    const { executor } = createExecutor();
    await executor.run("CREATE TABLE types (i INTEGER, r REAL, t TEXT)");
    await executor.run("INSERT INTO types VALUES (42, 3.14, 'hello')");

    const result = await executor.query("SELECT i, r, t FROM types");
    expect(result.values[0][0]).toBe(42);
    expect(result.values[0][1]).toBeCloseTo(3.14);
    expect(result.values[0][2]).toBe("hello");
  });

  it("should close the database", () => {
    const { executor, db } = createExecutor();
    executor.close();
    expect(() => db.prepare("SELECT 1")).toThrow();
  });
});

// ── BetterSqlite3Executor + sqlite3 command ───────────────────────

describe("sqlite3 command (BetterSqlite3Executor)", () => {
  function createShell() {
    const db = new Database(":memory:");
    const sql = new BetterSqlite3Executor(db);
    return new Bash({ sql });
  }

  it("should create table and query via shell", async () => {
    const shell = createShell();
    await shell.exec(
      "sqlite3 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)'"
    );
    await shell.exec("sqlite3 \"INSERT INTO people (name) VALUES ('Bob')\"");

    const result = await shell.exec(
      "sqlite3 -header -csv 'SELECT * FROM people'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id,name");
    expect(result.stdout).toContain("1,Bob");
  });

  it("should support JSON output", async () => {
    const shell = createShell();
    await shell.exec("sqlite3 'CREATE TABLE kv (key TEXT, val TEXT)'");
    await shell.exec("sqlite3 \"INSERT INTO kv VALUES ('x', '1')\"");

    const result = await shell.exec("sqlite3 -json 'SELECT * FROM kv'");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([{ key: "x", val: "1" }]);
  });

  it("should pipe SQL output to other commands", async () => {
    const shell = createShell();
    await shell.exec("sqlite3 'CREATE TABLE nums (n INTEGER)'");
    await shell.exec("sqlite3 'INSERT INTO nums VALUES (1)'");
    await shell.exec("sqlite3 'INSERT INTO nums VALUES (2)'");
    await shell.exec("sqlite3 'INSERT INTO nums VALUES (3)'");

    const result = await shell.exec(
      "sqlite3 -list 'SELECT n FROM nums ORDER BY n' | wc -l"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  });
});

// ── ChildProcessExecutor ──────────────────────────────────────────

describe("ChildProcessExecutor", () => {
  it("should execute JavaScript code", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute(
      'console.log("hello from node")',
      "javascript"
    );
    expect(result.stdout.trim()).toBe("hello from node");
    expect(result.exitCode).toBe(0);
  });

  it("should handle JavaScript syntax errors", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute("function {invalid", "javascript");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });

  it("should handle JavaScript runtime errors", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute(
      'throw new Error("boom")',
      "javascript"
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("boom");
  });

  it("should capture stderr", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute(
      'console.error("warning")',
      "javascript"
    );
    expect(result.stderr.trim()).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("should pass environment variables", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute(
      "console.log(process.env.MY_VAR)",
      "javascript",
      { env: { MY_VAR: "test_value" } }
    );
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("should handle multiple output lines", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute(
      'console.log("a"); console.log("b"); console.log("c")',
      "javascript"
    );
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should execute Python code if python3 is available", async () => {
    const executor = new ChildProcessExecutor();
    const result = await executor.execute(
      'print("hello from python")',
      "python"
    );
    // python3 may not be installed; skip if exit code indicates missing binary
    if (result.exitCode === 0) {
      expect(result.stdout.trim()).toBe("hello from python");
    }
  });

  it("should respect custom node binary path", async () => {
    const executor = new ChildProcessExecutor({ nodeBin: "node" });
    const result = await executor.execute("console.log(1+1)", "javascript");
    expect(stripAnsi(result.stdout.trim())).toBe("2");
    expect(result.exitCode).toBe(0);
  });
});

// ── ChildProcessExecutor + js-exec command ────────────────────────

describe("js-exec command (ChildProcessExecutor)", () => {
  function createShell() {
    const executor = new ChildProcessExecutor();
    return new Bash({ executor });
  }

  it("should execute inline JavaScript via js-exec", async () => {
    const shell = createShell();
    const result = await shell.exec('js-exec "console.log(42)"');
    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout.trim())).toBe("42");
  });

  it("should execute JavaScript via pipe", async () => {
    const shell = createShell();
    const result = await shell.exec('echo "console.log(1+2+3)" | js-exec');
    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout.trim())).toBe("6");
  });

  it("node command should work as alias", async () => {
    const shell = createShell();
    const result = await shell.exec('node "console.log(99)"');
    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout.trim())).toBe("99");
  });

  it("should handle js-exec errors", async () => {
    const shell = createShell();
    const result = await shell.exec("js-exec \"throw new Error('failed')\"");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── TurndownConverter ─────────────────────────────────────────────

describe("TurndownConverter", () => {
  function createMockTurndown(response: string = "# Converted") {
    return {
      turndown: vi.fn().mockReturnValue(response)
    };
  }

  it("should convert HTML string to markdown", async () => {
    const mock = createMockTurndown("# Hello");
    const converter = new TurndownConverter(() => mock);
    const result = await converter.convert("<h1>Hello</h1>");
    expect(result).toBe("# Hello");
    expect(mock.turndown).toHaveBeenCalledWith("<h1>Hello</h1>");
  });

  it("should convert Uint8Array to markdown", async () => {
    const mock = createMockTurndown("# Binary");
    const converter = new TurndownConverter(() => mock);
    const input = new TextEncoder().encode("<h1>Binary</h1>");
    const result = await converter.convert(input);
    expect(result).toBe("# Binary");
    expect(mock.turndown).toHaveBeenCalledWith("<h1>Binary</h1>");
  });

  it("should create a new service instance per call", async () => {
    let callCount = 0;
    const factory = () => {
      callCount++;
      return { turndown: () => `call ${callCount}` };
    };
    const converter = new TurndownConverter(factory);
    await converter.convert("<p>1</p>");
    await converter.convert("<p>2</p>");
    expect(callCount).toBe(2);
  });
});

// ── TurndownConverter + html-to-markdown command ──────────────────

describe("html-to-markdown command (TurndownConverter)", () => {
  function createShell() {
    const mock = { turndown: () => "# Mocked" };
    const markdown = new TurndownConverter(() => mock);
    return new Bash({ markdown });
  }

  it("should convert via pipe", async () => {
    const shell = createShell();
    const result = await shell.exec('echo "<h1>Test</h1>" | html-to-markdown');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Mocked");
  });

  it("should convert from file", async () => {
    const shell = createShell();
    await shell.fs.writeFile("/test.html", "<p>Content</p>");
    const result = await shell.exec("html-to-markdown /test.html");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Mocked");
  });
});
