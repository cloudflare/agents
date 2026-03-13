import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getStub() {
  const id = env.TEST_SHELL_DO.newUniqueId();
  return env.TEST_SHELL_DO.get(id);
}

// ── DOSqlExecutor with real DO SqlStorage ──────────────────────

describe("DOSqlExecutor (real SqlStorage)", () => {
  it("should create a table and insert rows", async () => {
    const stub = getStub();
    await stub.run(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)"
    );
    const insert = await stub.run(
      "INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')"
    );
    expect(insert.changes).toBe(1);
  });

  it("should query rows after insert", async () => {
    const stub = getStub();
    await stub.run("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
    await stub.run("INSERT INTO items (label) VALUES ('one')");
    await stub.run("INSERT INTO items (label) VALUES ('two')");
    await stub.run("INSERT INTO items (label) VALUES ('three')");

    const result = (await stub.query(
      "SELECT id, label FROM items ORDER BY id"
    )) as {
      columns: string[];
      values: [number, string][];
    };
    expect(result.columns).toEqual(["id", "label"]);
    expect(result.values).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "three"]
    ]);
  });

  it("should return 0 changes for no-op DELETE", async () => {
    const stub = getStub();
    await stub.run("CREATE TABLE empty (id INTEGER PRIMARY KEY)");
    const result = await stub.run("DELETE FROM empty WHERE id = 999");
    expect(result.changes).toBe(0);
  });

  it("should handle UPDATE and return correct changes count", async () => {
    const stub = getStub();
    await stub.run("CREATE TABLE scores (id INTEGER PRIMARY KEY, val INTEGER)");
    await stub.run("INSERT INTO scores (val) VALUES (10)");
    await stub.run("INSERT INTO scores (val) VALUES (20)");
    await stub.run("INSERT INTO scores (val) VALUES (30)");

    const result = await stub.run(
      "UPDATE scores SET val = val + 1 WHERE val > 15"
    );
    expect(result.changes).toBe(2);
  });

  it("should handle NULL values", async () => {
    const stub = getStub();
    await stub.run("CREATE TABLE nullable (id INTEGER PRIMARY KEY, val TEXT)");
    await stub.run("INSERT INTO nullable (val) VALUES (NULL)");

    const result = (await stub.query("SELECT id, val FROM nullable")) as {
      values: [number, null][];
    };
    expect(result.values).toEqual([[1, null]]);
  });

  it("should handle empty result set", async () => {
    const stub = getStub();
    await stub.run("CREATE TABLE empty2 (id INTEGER PRIMARY KEY, name TEXT)");

    const result = (await stub.query("SELECT * FROM empty2")) as {
      columns: string[];
      values: unknown[][];
    };
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.values).toEqual([]);
  });

  it("should support multiple data types", async () => {
    const stub = getStub();
    await stub.run("CREATE TABLE types (i INTEGER, r REAL, t TEXT, b BLOB)");
    await stub.run("INSERT INTO types VALUES (42, 3.14, 'hello', X'DEADBEEF')");

    const result = (await stub.query("SELECT i, r, t FROM types")) as {
      values: [number, number, string][];
    };
    expect(result.values[0][0]).toBe(42);
    expect(result.values[0][1]).toBeCloseTo(3.14);
    expect(result.values[0][2]).toBe("hello");
  });
});

// ── sqlite3 command with real SqlStorage ────────────────────────────

describe("sqlite3 command (real SqlStorage)", () => {
  it("should create table and query via shell command", async () => {
    const stub = getStub();
    const create = await stub.execShellCommand(
      "sqlite3 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)'"
    );
    expect(create.exitCode).toBe(0);

    const insert = await stub.execShellCommand(
      "sqlite3 \"INSERT INTO people (name) VALUES ('Bob')\""
    );
    expect(insert.exitCode).toBe(0);

    const select = await stub.execShellCommand(
      "sqlite3 -header -csv 'SELECT * FROM people'"
    );
    expect(select.exitCode).toBe(0);
    expect(select.stdout).toContain("id,name");
    expect(select.stdout).toContain("1,Bob");
  });

  it("should support JSON output mode", async () => {
    const stub = getStub();
    await stub.execShellCommand(
      "sqlite3 'CREATE TABLE kv (key TEXT, val TEXT)'"
    );
    await stub.execShellCommand("sqlite3 \"INSERT INTO kv VALUES ('a', '1')\"");
    await stub.execShellCommand("sqlite3 \"INSERT INTO kv VALUES ('b', '2')\"");

    const result = await stub.execShellCommand(
      "sqlite3 -json 'SELECT * FROM kv ORDER BY key'"
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([
      { key: "a", val: "1" },
      { key: "b", val: "2" }
    ]);
  });

  it("should support column output mode", async () => {
    const stub = getStub();
    await stub.execShellCommand(
      "sqlite3 'CREATE TABLE col (name TEXT, age INTEGER)'"
    );
    await stub.execShellCommand(
      "sqlite3 \"INSERT INTO col VALUES ('Alice', 30)\""
    );

    const result = await stub.execShellCommand(
      "sqlite3 -column 'SELECT * FROM col'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("name");
    expect(result.stdout).toContain("age");
    expect(result.stdout).toContain("Alice");
    expect(result.stdout).toContain("30");
  });

  it("should support line output mode", async () => {
    const stub = getStub();
    await stub.execShellCommand("sqlite3 'CREATE TABLE ln (x TEXT, y TEXT)'");
    await stub.execShellCommand(
      "sqlite3 \"INSERT INTO ln VALUES ('hello', 'world')\""
    );

    const result = await stub.execShellCommand(
      "sqlite3 -line 'SELECT * FROM ln'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("x = hello");
    expect(result.stdout).toContain("y = world");
  });

  it("should report changes for INSERT", async () => {
    const stub = getStub();
    await stub.execShellCommand(
      "sqlite3 'CREATE TABLE ch (id INTEGER PRIMARY KEY)'"
    );
    const result = await stub.execShellCommand(
      "sqlite3 'INSERT INTO ch VALUES (1)'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Changes: 1");
  });

  it("should handle SQL errors gracefully", async () => {
    const stub = getStub();
    const result = await stub.execShellCommand(
      "sqlite3 'SELECT * FROM nonexistent'"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error:");
  });

  it("should support piping SQL output to other commands", async () => {
    const stub = getStub();
    await stub.execShellCommand("sqlite3 'CREATE TABLE nums (n INTEGER)'");
    await stub.execShellCommand("sqlite3 'INSERT INTO nums VALUES (1)'");
    await stub.execShellCommand("sqlite3 'INSERT INTO nums VALUES (2)'");
    await stub.execShellCommand("sqlite3 'INSERT INTO nums VALUES (3)'");

    const result = await stub.execShellCommand(
      "sqlite3 -list 'SELECT n FROM nums ORDER BY n' | wc -l"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  });

  it("should show help", async () => {
    const stub = getStub();
    const result = await stub.execShellCommand("sqlite3 --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sqlite3");
  });
});
