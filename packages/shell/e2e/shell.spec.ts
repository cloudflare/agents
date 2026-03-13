import { test, expect } from "@playwright/test";

// ── Helpers ──────────────────────────────────────────────────────────

/** POST to /exec with a shell command */
async function exec(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  cmd: string,
  options?: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    cwd?: string;
    room?: string;
  }
) {
  const url = options?.room
    ? `${baseURL}/exec?room=${options.room}`
    : `${baseURL}/exec`;
  const res = await request.post(url, {
    data: {
      cmd,
      options: { files: options?.files, env: options?.env, cwd: options?.cwd }
    }
  });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

/** POST to /exec-many with multiple commands on the same shell */
async function execMany(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  commands: string[],
  options?: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    cwd?: string;
    room?: string;
  }
) {
  const url = options?.room
    ? `${baseURL}/exec-many?room=${options.room}`
    : `${baseURL}/exec-many`;
  const res = await request.post(url, {
    data: {
      commands,
      options: { files: options?.files, env: options?.env, cwd: options?.cwd }
    }
  });
  expect(res.ok()).toBe(true);
  return res.json() as Promise<
    { stdout: string; stderr: string; exitCode: number }[]
  >;
}

// ── Core shell commands ─────────────────────────────────────────────

test.describe("Shell core (Workers runtime)", () => {
  test("echo", async ({ request, baseURL }) => {
    const r = await exec(request, baseURL!, 'echo "hello workers"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello workers\n");
  });

  test("pipe: sort", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'echo -e "cherry\\napple\\nbanana" | sort'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("apple\nbanana\ncherry\n");
  });

  test("grep", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'echo -e "INFO: ok\\nERROR: bad\\nINFO: done" | grep ERROR'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ERROR: bad\n");
  });

  test("jq", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "echo '{\"a\":1,\"b\":2}' | jq '.b'"
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("2");
  });

  test("awk", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "echo -e '10\\n20\\n30' | awk '{s+=$1} END {print s}'"
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("60");
  });

  test("sed", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "echo 'hello world' | sed 's/world/workers/'"
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello workers\n");
  });

  test("redirects and file I/O", async ({ request, baseURL }) => {
    const results = await execMany(request, baseURL!, [
      'echo "line1" > /tmp/test.txt',
      'echo "line2" >> /tmp/test.txt',
      "cat /tmp/test.txt"
    ]);
    expect(results[2].exitCode).toBe(0);
    expect(results[2].stdout).toBe("line1\nline2\n");
  });

  test("base64 encode/decode", async ({ request, baseURL }) => {
    const results = await execMany(request, baseURL!, [
      "echo -n 'workers' | base64",
      "echo -n 'd29ya2Vycw==' | base64 -d"
    ]);
    expect(results[0].exitCode).toBe(0);
    expect(results[0].stdout.trim()).toBe("d29ya2Vycw==");
    expect(results[1].exitCode).toBe(0);
    expect(results[1].stdout).toBe("workers");
  });

  test("for loop", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'for i in 1 2 3; do echo "$i"; done'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  test("command substitution", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'echo "count: $(echo -e "a\\nb\\nc" | wc -l)"'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toContain("3");
  });

  test("environment variables", async ({ request, baseURL }) => {
    const r = await exec(request, baseURL!, "echo $MY_VAR", {
      env: { MY_VAR: "from_test" }
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("from_test\n");
  });

  test("initial files", async ({ request, baseURL }) => {
    const r = await exec(request, baseURL!, "cat /data.json | jq '.name'", {
      files: { "/data.json": JSON.stringify({ name: "test" }) }
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('"test"');
  });

  test("find command", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "find /project -name '*.ts' | sort",
      {
        files: {
          "/project/src/index.ts": "",
          "/project/src/utils.ts": "",
          "/project/README.md": ""
        }
      }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("/project/src/index.ts\n/project/src/utils.ts\n");
  });

  test("heredoc", async ({ request, baseURL }) => {
    const r = await exec(request, baseURL!, "cat << EOF\nhello\nworld\nEOF");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello\nworld\n");
  });

  test("functions", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'greet() { echo "hi $1"; }; greet workers'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi workers\n");
  });

  test("arrays", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'arr=(one two three); echo "${arr[1]}"'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("two\n");
  });
});

// ── SQL via DOSqlExecutor ───────────────────────────────────────

test.describe("sqlite3 command (real SqlStorage)", () => {
  test("create table and query", async ({ request, baseURL }) => {
    const room = crypto.randomUUID();
    const opts = { room };

    const create = await exec(
      request,
      baseURL!,
      "sqlite3 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)'",
      opts
    );
    expect(create.exitCode).toBe(0);

    const insert = await exec(
      request,
      baseURL!,
      "sqlite3 \"INSERT INTO people (name) VALUES ('Alice')\"",
      opts
    );
    expect(insert.exitCode).toBe(0);

    const select = await exec(
      request,
      baseURL!,
      "sqlite3 -json 'SELECT * FROM people'",
      opts
    );
    expect(select.exitCode).toBe(0);
    const rows = JSON.parse(select.stdout);
    expect(rows).toEqual([{ id: 1, name: "Alice" }]);
  });

  test("CSV output mode", async ({ request, baseURL }) => {
    const room = crypto.randomUUID();
    const opts = { room };

    await exec(
      request,
      baseURL!,
      "sqlite3 'CREATE TABLE kv (key TEXT, val TEXT)'",
      opts
    );
    await exec(
      request,
      baseURL!,
      "sqlite3 \"INSERT INTO kv VALUES ('a', '1')\"",
      opts
    );
    await exec(
      request,
      baseURL!,
      "sqlite3 \"INSERT INTO kv VALUES ('b', '2')\"",
      opts
    );

    const r = await exec(
      request,
      baseURL!,
      "sqlite3 -header -csv 'SELECT * FROM kv ORDER BY key'",
      opts
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("key,val");
    expect(r.stdout).toContain("a,1");
    expect(r.stdout).toContain("b,2");
  });

  test("pipe SQL output to shell commands", async ({ request, baseURL }) => {
    const room = crypto.randomUUID();

    // Use execMany to set up data, then pipe
    const results = await execMany(
      request,
      baseURL!,
      [
        "sqlite3 'CREATE TABLE nums (n INTEGER)'",
        "sqlite3 'INSERT INTO nums VALUES (1)'",
        "sqlite3 'INSERT INTO nums VALUES (2)'",
        "sqlite3 'INSERT INTO nums VALUES (3)'",
        "sqlite3 -list 'SELECT n FROM nums ORDER BY n' | wc -l"
      ],
      { room }
    );
    const last = results[results.length - 1];
    expect(last.exitCode).toBe(0);
    expect(last.stdout.trim()).toBe("3");
  });

  test("SQL error handling", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "sqlite3 'SELECT * FROM nonexistent'"
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Error:");
  });
});

// ── Raw SQL via DOSqlExecutor ───────────────────────────────────

test.describe("DOSqlExecutor (raw DO SqlStorage)", () => {
  test("query returns columns and values", async ({ request, baseURL }) => {
    const room = crypto.randomUUID();
    const url = `${baseURL}/sql/run?room=${room}`;

    await request.post(url, {
      data: {
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)"
      }
    });
    await request.post(url, {
      data: {
        sql: "INSERT INTO users (name, email) VALUES ('Alice', 'alice@test.com')"
      }
    });
    await request.post(url, {
      data: {
        sql: "INSERT INTO users (name, email) VALUES ('Bob', 'bob@test.com')"
      }
    });

    const queryRes = await request.post(`${baseURL}/sql/query?room=${room}`, {
      data: { sql: "SELECT id, name FROM users ORDER BY id" }
    });
    const result = await queryRes.json();
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.values).toEqual([
      [1, "Alice"],
      [2, "Bob"]
    ]);
  });

  test("run returns changes count", async ({ request, baseURL }) => {
    const room = crypto.randomUUID();
    const url = `${baseURL}/sql/run?room=${room}`;

    await request.post(url, {
      data: { sql: "CREATE TABLE scores (id INTEGER PRIMARY KEY, val INTEGER)" }
    });
    await request.post(url, {
      data: { sql: "INSERT INTO scores (val) VALUES (10)" }
    });
    await request.post(url, {
      data: { sql: "INSERT INTO scores (val) VALUES (20)" }
    });
    await request.post(url, {
      data: { sql: "INSERT INTO scores (val) VALUES (30)" }
    });

    const updateRes = await request.post(url, {
      data: { sql: "UPDATE scores SET val = val + 1 WHERE val > 15" }
    });
    const result = await updateRes.json();
    expect(result.changes).toBe(2);
  });
});

// ── Code execution via DynamicIsolateExecutor ────────────────────────

test.describe("Code execution (Workers runtime)", () => {
  test("js-exec inline", async ({ request, baseURL }) => {
    const r = await exec(request, baseURL!, 'js-exec "console.log(2 + 2)"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("4");
  });

  test("js-exec via pipe", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      'echo "console.log(1+2+3)" | js-exec'
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("6");
  });

  test("js-exec error handling", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "js-exec \"throw new Error('boom')\""
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("boom");
  });

  test("node command alias", async ({ request, baseURL }) => {
    const r = await exec(request, baseURL!, 'node "console.log(99)"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("99");
  });

  test("console.error goes to stderr", async ({ request, baseURL }) => {
    const r = await exec(
      request,
      baseURL!,
      "js-exec \"console.error('warning')\""
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("warning");
  });
});
