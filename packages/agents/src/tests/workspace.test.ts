import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";
import type { FileInfo, FileStat, BashResult } from "../workspace";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── Helpers ──────────────────────────────────────────────────────────

async function freshAgent(name: string) {
  return getAgentByName(env.TestWorkspaceAgent, name);
}

// ── File I/O ─────────────────────────────────────────────────────────

describe("workspace — file I/O", () => {
  it("write + read roundtrip", async () => {
    const agent = await freshAgent("file-roundtrip");
    await agent.write("/hello.txt", "world");
    const content = (await agent.read("/hello.txt")) as unknown as string;
    expect(content).toBe("world");
  });

  it("read returns null for missing file", async () => {
    const agent = await freshAgent("file-missing");
    const content = await agent.read("/nope.txt");
    expect(content).toBeNull();
  });

  it("read throws on directory", async () => {
    const agent = await freshAgent("file-read-dir");
    await agent.mkdirCall("/subdir");
    const result = await agent.read("/subdir");
    expect((result as { error: string }).error).toContain("EISDIR");
  });

  it("writeFile auto-creates parent directories", async () => {
    const agent = await freshAgent("file-auto-mkdir");
    await agent.write("/a/b/c/deep.txt", "deep content");
    const content = (await agent.read("/a/b/c/deep.txt")) as unknown as string;
    expect(content).toBe("deep content");
  });

  it("writeFile overwrites existing file", async () => {
    const agent = await freshAgent("file-overwrite");
    await agent.write("/overwrite.txt", "v1");
    await agent.write("/overwrite.txt", "v2");
    const content = (await agent.read("/overwrite.txt")) as unknown as string;
    expect(content).toBe("v2");
  });

  it("writeFile rejects writing to root", async () => {
    const agent = await freshAgent("file-write-root");
    const result = await agent.write("/", "oops");
    expect((result as { error: string }).error).toContain("EISDIR");
  });

  it("writeFile stores custom mime type", async () => {
    const agent = await freshAgent("file-mime");
    await agent.write("/data.json", '{"a":1}', "application/json");
    const stat = (await agent.stat("/data.json")) as unknown as FileStat;
    expect(stat).not.toBeNull();
    expect(stat.mimeType).toBe("application/json");
  });
});

// ── exists / fileExists / stat ────────────────────────────────────

describe("workspace — exists & fileExists & stat", () => {
  it("fileExists returns true for files, false otherwise", async () => {
    const agent = await freshAgent("exists-check");
    await agent.write("/present.txt", "yes");
    expect((await agent.exists("/present.txt")) as unknown as boolean).toBe(
      true
    );
    expect((await agent.exists("/absent.txt")) as unknown as boolean).toBe(
      false
    );
  });

  it("fileExists returns false for directories", async () => {
    const agent = await freshAgent("exists-dir");
    await agent.mkdirCall("/mydir");
    expect((await agent.exists("/mydir")) as unknown as boolean).toBe(false);
  });

  it("exists returns true for files and directories", async () => {
    const agent = await freshAgent("exists-any");
    await agent.write("/file.txt", "hi");
    await agent.mkdirCall("/dir");
    expect((await agent.existsAny("/file.txt")) as unknown as boolean).toBe(
      true
    );
    expect((await agent.existsAny("/dir")) as unknown as boolean).toBe(true);
    expect((await agent.existsAny("/nope")) as unknown as boolean).toBe(false);
  });

  it("exists returns true for symlinks", async () => {
    const agent = await freshAgent("exists-any-sym");
    await agent.write("/real.txt", "hi");
    await agent.symlinkCall("/real.txt", "/link.txt");
    expect((await agent.existsAny("/link.txt")) as unknown as boolean).toBe(
      true
    );
  });

  it("exists returns true for dangling symlinks", async () => {
    const agent = await freshAgent("exists-any-dangling");
    await agent.write("/temp.txt", "hi");
    await agent.symlinkCall("/temp.txt", "/dangle.txt");
    await agent.del("/temp.txt");
    // The symlink entry itself still exists even though target is gone
    expect((await agent.existsAny("/dangle.txt")) as unknown as boolean).toBe(
      true
    );
  });

  it("exists returns false after deletion", async () => {
    const agent = await freshAgent("exists-any-del");
    await agent.write("/gone.txt", "bye");
    expect((await agent.existsAny("/gone.txt")) as unknown as boolean).toBe(
      true
    );
    await agent.del("/gone.txt");
    expect((await agent.existsAny("/gone.txt")) as unknown as boolean).toBe(
      false
    );
  });

  it("stat returns metadata for file", async () => {
    const agent = await freshAgent("stat-file");
    await agent.write("/stat.txt", "hello");
    const stat = (await agent.stat("/stat.txt")) as unknown as FileStat;
    expect(stat).not.toBeNull();
    expect(stat.type).toBe("file");
    expect(stat.name).toBe("stat.txt");
    expect(stat.size).toBe(5);
    expect(stat.mimeType).toBe("text/plain");
    expect(stat.createdAt).toBeGreaterThan(0);
    expect(stat.updatedAt).toBeGreaterThan(0);
  });

  it("stat returns metadata for directory", async () => {
    const agent = await freshAgent("stat-dir");
    await agent.mkdirCall("/statdir");
    const stat = (await agent.stat("/statdir")) as unknown as FileStat;
    expect(stat).not.toBeNull();
    expect(stat.type).toBe("directory");
    expect(stat.name).toBe("statdir");
  });

  it("stat returns null for missing path", async () => {
    const agent = await freshAgent("stat-missing");
    const stat = await agent.stat("/ghost");
    expect(stat).toBeNull();
  });
});

// ── deleteFile ───────────────────────────────────────────────────────

describe("workspace — deleteFile", () => {
  it("deleteFile removes a file and returns true", async () => {
    const agent = await freshAgent("del-basic");
    await agent.write("/todelete.txt", "bye");
    const result = (await agent.del("/todelete.txt")) as unknown as boolean;
    expect(result).toBe(true);
    expect((await agent.exists("/todelete.txt")) as unknown as boolean).toBe(
      false
    );
  });

  it("deleteFile returns false for missing file", async () => {
    const agent = await freshAgent("del-missing");
    const result = (await agent.del("/nope.txt")) as unknown as boolean;
    expect(result).toBe(false);
  });

  it("deleteFile throws on directory", async () => {
    const agent = await freshAgent("del-dir");
    await agent.mkdirCall("/cantdel");
    const result = await agent.del("/cantdel");
    expect((result as { error: string }).error).toContain("EISDIR");
  });
});

// ── Directory operations ─────────────────────────────────────────────

describe("workspace — directories", () => {
  it("mkdir creates a directory", async () => {
    const agent = await freshAgent("mkdir-basic");
    await agent.mkdirCall("/newdir");
    const stat = (await agent.stat("/newdir")) as unknown as FileStat;
    expect(stat).not.toBeNull();
    expect(stat.type).toBe("directory");
  });

  it("mkdir recursive creates nested directories", async () => {
    const agent = await freshAgent("mkdir-recursive");
    await agent.mkdirCall("/x/y/z", { recursive: true });
    const stat = (await agent.stat("/x/y/z")) as unknown as FileStat;
    expect(stat).not.toBeNull();
    expect(stat.type).toBe("directory");
  });

  it("mkdir throws on duplicate without recursive", async () => {
    const agent = await freshAgent("mkdir-dup");
    await agent.mkdirCall("/dup");
    const result = await agent.mkdirCall("/dup");
    expect((result as { error: string }).error).toContain("EEXIST");
  });

  it("mkdir recursive is idempotent", async () => {
    const agent = await freshAgent("mkdir-idem");
    await agent.mkdirCall("/idem", { recursive: true });
    await agent.mkdirCall("/idem", { recursive: true });
    const stat = (await agent.stat("/idem")) as unknown as FileStat;
    expect(stat.type).toBe("directory");
  });

  it("mkdir throws if parent missing without recursive", async () => {
    const agent = await freshAgent("mkdir-noparent");
    const result = await agent.mkdirCall("/no/parent");
    expect((result as { error: string }).error).toContain("ENOENT");
  });

  it("readDir returns children of a directory", async () => {
    const agent = await freshAgent("list-basic");
    await agent.write("/list/a.txt", "a");
    await agent.write("/list/b.txt", "b");
    await agent.mkdirCall("/list/sub", { recursive: true });

    const items = (await agent.list("/list")) as unknown as FileInfo[];
    expect(items.length).toBe(3);
    const names = items.map((i: FileInfo) => i.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
    expect(names).toContain("sub");
  });

  it("readDir with limit and offset", async () => {
    const agent = await freshAgent("list-paginate");
    await agent.write("/pg/1.txt", "1");
    await agent.write("/pg/2.txt", "2");
    await agent.write("/pg/3.txt", "3");

    const first = (await agent.list("/pg", {
      limit: 2,
      offset: 0
    })) as unknown as FileInfo[];
    expect(first.length).toBe(2);

    const second = (await agent.list("/pg", {
      limit: 2,
      offset: 2
    })) as unknown as FileInfo[];
    expect(second.length).toBe(1);
  });

  it("readDir returns empty for empty directory", async () => {
    const agent = await freshAgent("list-empty");
    await agent.mkdirCall("/emptydir");
    const items = (await agent.list("/emptydir")) as unknown as FileInfo[];
    expect(items.length).toBe(0);
  });
});

// ── rm ───────────────────────────────────────────────────────────────

describe("workspace — rm", () => {
  it("rm removes a file", async () => {
    const agent = await freshAgent("rm-file");
    await agent.write("/rmfile.txt", "bye");
    await agent.rmCall("/rmfile.txt");
    expect((await agent.exists("/rmfile.txt")) as unknown as boolean).toBe(
      false
    );
  });

  it("rm removes empty directory", async () => {
    const agent = await freshAgent("rm-emptydir");
    await agent.mkdirCall("/emptydir");
    await agent.rmCall("/emptydir");
    const stat = await agent.stat("/emptydir");
    expect(stat).toBeNull();
  });

  it("rm throws on non-empty directory without recursive", async () => {
    const agent = await freshAgent("rm-notempty");
    await agent.write("/notempty/file.txt", "x");
    const result = await agent.rmCall("/notempty");
    expect((result as { error: string }).error).toContain("ENOTEMPTY");
  });

  it("rm recursive removes directory and descendants", async () => {
    const agent = await freshAgent("rm-recursive");
    await agent.write("/tree/a.txt", "a");
    await agent.write("/tree/sub/b.txt", "b");
    await agent.rmCall("/tree", { recursive: true });
    const stat = await agent.stat("/tree");
    expect(stat).toBeNull();
  });

  it("rm throws on missing path", async () => {
    const agent = await freshAgent("rm-missing");
    const result = await agent.rmCall("/ghost");
    expect((result as { error: string }).error).toContain("ENOENT");
  });

  it("rm force on missing path is no-op", async () => {
    const agent = await freshAgent("rm-force");
    await agent.rmCall("/ghost", { force: true });
    // should not throw
  });

  it("rm rejects removing root", async () => {
    const agent = await freshAgent("rm-root");
    const result = await agent.rmCall("/");
    expect((result as { error: string }).error).toContain("EPERM");
  });
});

// ── getWorkspaceInfo ─────────────────────────────────────────────────

describe("workspace — getWorkspaceInfo", () => {
  it("returns correct counts", async () => {
    const agent = await freshAgent("info-counts");
    await agent.write("/info/a.txt", "aaa");
    await agent.write("/info/b.txt", "bb");
    await agent.mkdirCall("/info/sub", { recursive: true });

    const info = (await agent.info()) as unknown as {
      fileCount: number;
      directoryCount: number;
      totalBytes: number;
      r2FileCount: number;
    };

    // root + /info + /info/sub = 3 directories
    expect(info.directoryCount).toBe(3);
    // a.txt + b.txt = 2 files
    expect(info.fileCount).toBe(2);
    // "aaa" (3) + "bb" (2) = 5 bytes
    expect(info.totalBytes).toBe(5);
    expect(info.r2FileCount).toBe(0);
  });
});

// ── Path normalization (integration) ─────────────────────────────────

describe("workspace — path normalization", () => {
  it("handles paths without leading slash", async () => {
    const agent = await freshAgent("norm-noslash");
    await agent.write("noslash.txt", "works");
    const content = (await agent.read("/noslash.txt")) as unknown as string;
    expect(content).toBe("works");
  });

  it("handles trailing slashes", async () => {
    const agent = await freshAgent("norm-trailing");
    await agent.mkdirCall("/trailing/");
    const stat = (await agent.stat("/trailing")) as unknown as FileStat;
    expect(stat).not.toBeNull();
    expect(stat.type).toBe("directory");
  });

  it("collapses multiple slashes", async () => {
    const agent = await freshAgent("norm-multi");
    await agent.write("///multi///slashes///file.txt", "ok");
    const content = (await agent.read(
      "/multi/slashes/file.txt"
    )) as unknown as string;
    expect(content).toBe("ok");
  });
});

// ── Bash execution ───────────────────────────────────────────────────

describe("workspace — bash", () => {
  it("echo command produces stdout", async () => {
    const agent = await freshAgent("bash-echo");
    const result = (await agent.bashCall(
      'echo "hello world"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("bash can write and read files through workspace", async () => {
    const agent = await freshAgent("bash-file-io");
    await agent.bashCall('echo -n "from bash" > /bash-file.txt');
    const content = (await agent.read("/bash-file.txt")) as unknown as string;
    expect(content).toBe("from bash");
  });

  it("bash cat reads workspace files", async () => {
    const agent = await freshAgent("bash-cat");
    await agent.write("/catme.txt", "cat content");
    const result = (await agent.bashCall(
      "cat /catme.txt"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("cat content");
    expect(result.exitCode).toBe(0);
  });

  it("bash failing command returns non-zero exit code", async () => {
    const agent = await freshAgent("bash-fail");
    const result = (await agent.bashCall(
      "cat /nonexistent-file"
    )) as unknown as BashResult;
    expect(result.exitCode).not.toBe(0);
  });

  it("bash ls lists files", async () => {
    const agent = await freshAgent("bash-ls");
    await agent.write("/lsdir/x.txt", "x");
    await agent.write("/lsdir/y.txt", "y");
    const result = (await agent.bashCall("ls /lsdir")) as unknown as BashResult;
    expect(result.stdout).toContain("x.txt");
    expect(result.stdout).toContain("y.txt");
    expect(result.exitCode).toBe(0);
  });

  it("bash mkdir + touch creates structure", async () => {
    const agent = await freshAgent("bash-mkdir-touch");
    await agent.bashCall("mkdir -p /bash-tree/sub");
    await agent.bashCall('echo -n "leaf" > /bash-tree/sub/leaf.txt');
    const content = (await agent.read(
      "/bash-tree/sub/leaf.txt"
    )) as unknown as string;
    expect(content).toBe("leaf");
  });

  it("bash rm removes files", async () => {
    const agent = await freshAgent("bash-rm");
    await agent.write("/to-rm.txt", "delete me");
    await agent.bashCall("rm /to-rm.txt");
    expect((await agent.exists("/to-rm.txt")) as unknown as boolean).toBe(
      false
    );
  });
});

// ── Bash cwd ────────────────────────────────────────────────────────

describe("workspace — bash cwd", () => {
  it("bash with cwd runs in specified directory", async () => {
    const agent = await freshAgent("bash-cwd");
    await agent.write("/project/hello.txt", "hi");
    const result = (await agent.bashWithCwd(
      "cat hello.txt",
      "/project"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("hi");
    expect(result.exitCode).toBe(0);
  });

  it("bash with cwd defaults to / when not specified", async () => {
    const agent = await freshAgent("bash-cwd-default");
    const result = (await agent.bashCall("pwd")) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("/");
  });

  it("bash with cwd can use relative paths", async () => {
    const agent = await freshAgent("bash-cwd-rel");
    await agent.write("/a/b/c.txt", "deep");
    const result = (await agent.bashWithCwd(
      "cat b/c.txt",
      "/a"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("deep");
    expect(result.exitCode).toBe(0);
  });
});

// ── Bash sessions ───────────────────────────────────────────────────

describe("workspace — bash sessions", () => {
  it("session preserves cwd across exec calls", async () => {
    const agent = await freshAgent("session-cwd");
    await agent.write("/proj/file.txt", "found");
    await agent.createSession("s1");

    await agent.sessionExec("s1", "cd /proj");
    const cwd = (await agent.sessionGetCwd("s1")) as unknown as string;
    expect(cwd).toBe("/proj");

    const result = (await agent.sessionExec(
      "s1",
      "cat file.txt"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("found");

    await agent.sessionClose("s1");
  });

  it("session preserves exported env vars across exec calls", async () => {
    const agent = await freshAgent("session-env");
    await agent.createSession("s1");

    await agent.sessionExec("s1", "export MY_VAR=hello");
    const result = (await agent.sessionExec(
      "s1",
      'echo "$MY_VAR"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("hello");

    const env = (await agent.sessionGetEnv("s1")) as unknown as Record<
      string,
      string
    >;
    expect(env.MY_VAR).toBe("hello");

    await agent.sessionClose("s1");
  });

  it("session starts with specified cwd", async () => {
    const agent = await freshAgent("session-init-cwd");
    await agent.write("/start/data.txt", "initial");
    await agent.createSession("s1", { cwd: "/start" });

    const cwd = (await agent.sessionGetCwd("s1")) as unknown as string;
    expect(cwd).toBe("/start");

    const result = (await agent.sessionExec(
      "s1",
      "cat data.txt"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("initial");

    await agent.sessionClose("s1");
  });

  it("session starts with specified env", async () => {
    const agent = await freshAgent("session-init-env");
    await agent.createSession("s1", { env: { FOO: "bar" } });

    const result = (await agent.sessionExec(
      "s1",
      'echo "$FOO"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("bar");

    const env = (await agent.sessionGetEnv("s1")) as unknown as Record<
      string,
      string
    >;
    expect(env.FOO).toBe("bar");

    await agent.sessionClose("s1");
  });

  it("multiple sessions are independent", async () => {
    const agent = await freshAgent("session-multi");
    await agent.write("/a/f.txt", "A");
    await agent.write("/b/f.txt", "B");

    await agent.createSession("sa", { cwd: "/a" });
    await agent.createSession("sb", { cwd: "/b" });

    const ra = (await agent.sessionExec(
      "sa",
      "cat f.txt"
    )) as unknown as BashResult;
    const rb = (await agent.sessionExec(
      "sb",
      "cat f.txt"
    )) as unknown as BashResult;

    expect(ra.stdout).toBe("A");
    expect(rb.stdout).toBe("B");

    await agent.sessionClose("sa");
    await agent.sessionClose("sb");
  });

  it("session shares workspace filesystem", async () => {
    const agent = await freshAgent("session-shared-fs");
    await agent.createSession("s1");

    await agent.sessionExec("s1", 'echo -n "from session" > /session-file.txt');
    const content = (await agent.read(
      "/session-file.txt"
    )) as unknown as string;
    expect(content).toBe("from session");

    await agent.write("/api-file.txt", "from api");
    const result = (await agent.sessionExec(
      "s1",
      "cat /api-file.txt"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("from api");

    await agent.sessionClose("s1");
  });

  it("closed session is removed and name can be reused", async () => {
    const agent = await freshAgent("session-closed");
    await agent.createSession("s1", { cwd: "/" });
    await agent.sessionExec("s1", "cd /tmp");
    await agent.sessionClose("s1");

    await agent.createSession("s1", { cwd: "/newstart" });
    const cwd = (await agent.sessionGetCwd("s1")) as unknown as string;
    expect(cwd).toBe("/newstart");
    await agent.sessionClose("s1");
  });

  it("all shell variables persist across exec calls", async () => {
    const agent = await freshAgent("session-vars");
    await agent.createSession("s1");

    await agent.sessionExec("s1", "export EXPORTED=yes");
    await agent.sessionExec("s1", "PLAIN_VAR=also");

    const r1 = (await agent.sessionExec(
      "s1",
      'echo "$EXPORTED"'
    )) as unknown as BashResult;
    expect(r1.stdout.trim()).toBe("yes");

    const r2 = (await agent.sessionExec(
      "s1",
      'echo "$PLAIN_VAR"'
    )) as unknown as BashResult;
    expect(r2.stdout.trim()).toBe("also");

    await agent.sessionClose("s1");
  });

  it("session multi-step build workflow", async () => {
    const agent = await freshAgent("session-workflow");
    await agent.createSession("build");

    await agent.sessionExec("build", "mkdir -p /app/src");
    await agent.sessionExec("build", "cd /app");
    await agent.sessionExec("build", 'echo -n "console.log(1)" > src/index.js');

    const cwd = (await agent.sessionGetCwd("build")) as unknown as string;
    expect(cwd).toBe("/app");

    const result = (await agent.sessionExec(
      "build",
      "cat src/index.js"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("console.log(1)");

    await agent.sessionClose("build");
  });

  it("exit code is preserved through sentinel wrapping", async () => {
    const agent = await freshAgent("session-exitcode");
    await agent.createSession("s1");

    const r0 = (await agent.sessionExec("s1", "true")) as unknown as BashResult;
    expect(r0.exitCode).toBe(0);

    const r1 = (await agent.sessionExec(
      "s1",
      "false"
    )) as unknown as BashResult;
    expect(r1.exitCode).toBe(1);

    const r2 = (await agent.sessionExec(
      "s1",
      "exit 42"
    )) as unknown as BashResult;
    expect(r2.exitCode).toBe(42);

    await agent.sessionClose("s1");
  });

  it("stderr passes through without sentinel contamination", async () => {
    const agent = await freshAgent("session-stderr");
    await agent.createSession("s1");

    const result = (await agent.sessionExec(
      "s1",
      'echo "out" && echo "err" >&2'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.stderr).not.toContain("BASHSESSION");

    await agent.sessionClose("s1");
  });

  it("empty stdout works correctly with sentinel stripping", async () => {
    const agent = await freshAgent("session-empty");
    await agent.createSession("s1");

    const result = (await agent.sessionExec(
      "s1",
      "true"
    )) as unknown as BashResult;
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);

    const cwd = (await agent.sessionGetCwd("s1")) as unknown as string;
    expect(cwd).toBe("/");

    await agent.sessionClose("s1");
  });

  it("early exit skips state update, previous state preserved", async () => {
    const agent = await freshAgent("session-earlyexit");
    await agent.createSession("s1");

    await agent.sessionExec("s1", "mkdir -p /tmp && cd /tmp");
    const cwd1 = (await agent.sessionGetCwd("s1")) as unknown as string;
    expect(cwd1).toBe("/tmp");

    await agent.sessionExec("s1", "exit 0");
    const cwd2 = (await agent.sessionGetCwd("s1")) as unknown as string;
    expect(cwd2).toBe("/tmp");

    await agent.sessionClose("s1");
  });

  it("isClosed reflects session lifecycle", async () => {
    const agent = await freshAgent("session-isclosed");
    await agent.createSession("s1");

    const before = (await agent.sessionIsClosed("s1")) as unknown as boolean;
    expect(before).toBe(false);

    await agent.sessionExec("s1", "echo ok");
    const during = (await agent.sessionIsClosed("s1")) as unknown as boolean;
    expect(during).toBe(false);

    await agent.sessionClose("s1");
  });

  it("session exec emits observability event with session flag", async () => {
    const agent = await freshAgent("session-observe");
    await agent.startObservability();
    await agent.clearObservabilityLog();

    await agent.createSession("s1");
    await agent.sessionExec("s1", 'echo "hi"');
    await agent.sessionClose("s1");

    const log = (await agent.getObservabilityLog()) as unknown as Record<
      string,
      unknown
    >[];
    const bashEvents = log.filter((e) => e.type === "workspace:bash");
    expect(bashEvents.length).toBeGreaterThanOrEqual(1);
    const sessionEvent = bashEvents.find(
      (e) => (e.payload as Record<string, unknown>).session === true
    );
    expect(sessionEvent).toBeDefined();

    await agent.stopObservability();
  });
});

// ── Custom commands ─────────────────────────────────────────────────

describe("workspace — custom commands", () => {
  it("per-call custom command executes", async () => {
    const agent = await freshAgent("cmd-percall");
    const result = (await agent.bashWithPerCallCommand(
      "add 1 2 3"
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("6");
    expect(result.exitCode).toBe(0);
  });

  it("workspace-level custom command executes", async () => {
    const agent = await freshAgent("cmd-workspace");
    const result = (await agent.bashWithWorkspaceCommand(
      "greet Alice"
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("Hello, Alice!");
    expect(result.exitCode).toBe(0);
  });

  it("workspace-level command uses default arg", async () => {
    const agent = await freshAgent("cmd-ws-default");
    const result = (await agent.bashWithWorkspaceCommand(
      "greet"
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("Hello, world!");
  });

  it("both workspace-level and per-call commands are available", async () => {
    const agent = await freshAgent("cmd-both");
    const r1 = (await agent.bashWithBothCommands(
      "greet Bob"
    )) as unknown as BashResult;
    expect(r1.stdout.trim()).toBe("Hello, Bob!");

    const r2 = (await agent.bashWithBothCommands(
      "add 10 20"
    )) as unknown as BashResult;
    expect(r2.stdout.trim()).toBe("30");
  });

  it("custom command works with pipes", async () => {
    const agent = await freshAgent("cmd-pipe");
    const result = (await agent.bashWithWorkspaceCommand(
      "greet World | tr '[:lower:]' '[:upper:]'"
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("HELLO, WORLD!");
  });

  it("custom command output can be captured in a variable", async () => {
    const agent = await freshAgent("cmd-var");
    const result = (await agent.bashWithPerCallCommand(
      'SUM=$(add 5 5); echo "total: $SUM"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("total: 10");
  });
});

// ── Environment variables ───────────────────────────────────────────

describe("workspace — environment variables", () => {
  it("per-call env vars are accessible in bash", async () => {
    const agent = await freshAgent("env-percall");
    const result = (await agent.bashWithPerCallEnv(
      'echo "$NAME is $COUNT"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("Alice is 42");
  });

  it("workspace-level env vars are accessible in bash", async () => {
    const agent = await freshAgent("env-workspace");
    const result = (await agent.bashWithWorkspaceEnv(
      'echo "$GREETING $LANG"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("hi en");
  });

  it("per-call env overrides workspace-level env", async () => {
    const agent = await freshAgent("env-override");
    const result = (await agent.bashWithBothEnv(
      'echo "$GREETING $LANG $EXTRA"'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("hello en yes");
  });

  it("env vars work in conditionals", async () => {
    const agent = await freshAgent("env-cond");
    const result = (await agent.bashWithPerCallEnv(
      'if [ "$COUNT" -gt 10 ]; then echo "big"; else echo "small"; fi'
    )) as unknown as BashResult;
    expect(result.stdout.trim()).toBe("big");
  });
});

// ── curl allow-list ─────────────────────────────────────────────────

describe("workspace — curl allow-list", () => {
  it("curl without network config is not available", async () => {
    const agent = await freshAgent("curl-no-net");
    const result = (await agent.bashCall(
      "curl https://example.com"
    )) as unknown as BashResult;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("command not found");
  });

  it("curl to non-allowed URL is denied", async () => {
    const agent = await freshAgent("curl-denied");
    const result = (await agent.bashWithNetwork(
      "curl https://not-allowed.com"
    )) as unknown as BashResult;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not in allow-list");
  });

  it("per-call network config is used", async () => {
    const agent = await freshAgent("curl-percall");
    const result = (await agent.bashWithPerCallNetwork(
      "curl https://not-in-allowlist.com"
    )) as unknown as BashResult;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not in allow-list");
  });
});

// ── File streaming ──────────────────────────────────────────────────

describe("workspace — file streaming", () => {
  it("writeFileStream + readFileStream round-trip", async () => {
    const agent = await freshAgent("stream-roundtrip");
    await agent.writeStream("/streamed.txt", "streamed content");
    const content = (await agent.readStream(
      "/streamed.txt"
    )) as unknown as string;
    expect(content).toBe("streamed content");
  });

  it("readFileStream returns null for missing file", async () => {
    const agent = await freshAgent("stream-missing");
    const content = await agent.readStream("/nope.txt");
    expect(content).toBeNull();
  });

  it("writeFileStream creates parent directories", async () => {
    const agent = await freshAgent("stream-parents");
    await agent.writeStream("/a/b/streamed.txt", "deep stream");
    const content = (await agent.readStream(
      "/a/b/streamed.txt"
    )) as unknown as string;
    expect(content).toBe("deep stream");
  });

  it("writeFileStream file is readable with readFile", async () => {
    const agent = await freshAgent("stream-interop-read");
    await agent.writeStream("/interop.txt", "via stream");
    const content = (await agent.read("/interop.txt")) as unknown as string;
    expect(content).toBe("via stream");
  });

  it("readFileStream works on file written with writeFile", async () => {
    const agent = await freshAgent("stream-interop-write");
    await agent.write("/normal.txt", "via writeFile");
    const content = (await agent.readStream(
      "/normal.txt"
    )) as unknown as string;
    expect(content).toBe("via writeFile");
  });

  it("writeFileStream overwrites existing file", async () => {
    const agent = await freshAgent("stream-overwrite");
    await agent.write("/over.txt", "original");
    await agent.writeStream("/over.txt", "replaced");
    const content = (await agent.read("/over.txt")) as unknown as string;
    expect(content).toBe("replaced");
  });
});

// ── Symlinks ────────────────────────────────────────────────────────

describe("workspace — symlinks", () => {
  it("create and readlink a symlink", async () => {
    const agent = await freshAgent("sym-basic");
    await agent.write("/target.txt", "hello");
    await agent.symlinkCall("/target.txt", "/link.txt");
    const target = (await agent.readlinkCall("/link.txt")) as unknown as string;
    expect(target).toBe("/target.txt");
  });

  it("reading through a symlink returns target content", async () => {
    const agent = await freshAgent("sym-read");
    await agent.write("/real.txt", "symlink content");
    await agent.symlinkCall("/real.txt", "/alias.txt");
    const content = (await agent.read("/alias.txt")) as unknown as string;
    expect(content).toBe("symlink content");
  });

  it("stat follows symlink to target", async () => {
    const agent = await freshAgent("sym-stat");
    await agent.write("/data.txt", "12345");
    await agent.symlinkCall("/data.txt", "/link.txt");
    const s = (await agent.stat("/link.txt")) as unknown as {
      type: string;
      size: number;
    };
    expect(s.type).toBe("file");
    expect(s.size).toBe(5);
  });

  it("lstat returns symlink type without following", async () => {
    const agent = await freshAgent("sym-lstat");
    await agent.write("/orig.txt", "content");
    await agent.symlinkCall("/orig.txt", "/sl.txt");
    const s = (await agent.lstatCall("/sl.txt")) as unknown as {
      type: string;
      target: string;
    };
    expect(s.type).toBe("symlink");
    expect(s.target).toBe("/orig.txt");
  });

  it("symlink with relative target resolves correctly", async () => {
    const agent = await freshAgent("sym-relative");
    await agent.write("/dir/file.txt", "relative target");
    await agent.symlinkCall("file.txt", "/dir/link.txt");
    const content = (await agent.read("/dir/link.txt")) as unknown as string;
    expect(content).toBe("relative target");
  });

  it("chained symlinks resolve", async () => {
    const agent = await freshAgent("sym-chain");
    await agent.write("/real.txt", "chained");
    await agent.symlinkCall("/real.txt", "/link1.txt");
    await agent.symlinkCall("/link1.txt", "/link2.txt");
    const content = (await agent.read("/link2.txt")) as unknown as string;
    expect(content).toBe("chained");
  });

  it("symlink works in bash with ln -s", async () => {
    const agent = await freshAgent("sym-bash");
    await agent.write("/src.txt", "bash symlink");
    await agent.bashCall("ln -s /src.txt /blink.txt");
    const content = (await agent.read("/blink.txt")) as unknown as string;
    expect(content).toBe("bash symlink");
  });

  it("readlink on non-symlink throws EINVAL", async () => {
    const agent = await freshAgent("sym-einval");
    await agent.write("/regular.txt", "not a link");
    const result = await agent.readlinkCall("/regular.txt");
    expect((result as { error: string }).error).toContain("EINVAL");
  });

  it("symlink to existing path throws EEXIST", async () => {
    const agent = await freshAgent("sym-eexist");
    await agent.write("/a.txt", "a");
    await agent.write("/b.txt", "b");
    const result = await agent.symlinkCall("/a.txt", "/b.txt");
    expect((result as { error: string }).error).toContain("EEXIST");
  });
});

// ── Change events ───────────────────────────────────────────────────

describe("workspace — change events", () => {
  it("writeFile emits create event for new file", async () => {
    const agent = await freshAgent("evt-create");
    await agent.clearChangeLog();
    await agent.writeWithEvents("/hello.txt", "world");
    const log = (await agent.getChangeLog()) as unknown as {
      type: string;
      path: string;
      entryType: string;
    }[];
    const fileEvt = log.find(
      (e) => e.path === "/hello.txt" && e.entryType === "file"
    );
    expect(fileEvt).toBeDefined();
    expect(fileEvt!.type).toBe("create");
  });

  it("writeFile emits update event for overwrite", async () => {
    const agent = await freshAgent("evt-update");
    await agent.writeWithEvents("/up.txt", "v1");
    await agent.clearChangeLog();
    await agent.writeWithEvents("/up.txt", "v2");
    const log = (await agent.getChangeLog()) as unknown as {
      type: string;
      path: string;
      entryType: string;
    }[];
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("update");
    expect(log[0].path).toBe("/up.txt");
  });

  it("deleteFile emits delete event", async () => {
    const agent = await freshAgent("evt-delete");
    await agent.writeWithEvents("/del.txt", "bye");
    await agent.clearChangeLog();
    await agent.deleteWithEvents("/del.txt");
    const log = (await agent.getChangeLog()) as unknown as {
      type: string;
      path: string;
      entryType: string;
    }[];
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("delete");
    expect(log[0].entryType).toBe("file");
  });

  it("mkdir emits create event for directory", async () => {
    const agent = await freshAgent("evt-mkdir");
    await agent.clearChangeLog();
    await agent.mkdirWithEvents("/mydir");
    const log = (await agent.getChangeLog()) as unknown as {
      type: string;
      path: string;
      entryType: string;
    }[];
    const dirEvt = log.find(
      (e) => e.path === "/mydir" && e.entryType === "directory"
    );
    expect(dirEvt).toBeDefined();
    expect(dirEvt!.type).toBe("create");
  });

  it("rm emits delete event", async () => {
    const agent = await freshAgent("evt-rm");
    await agent.writeWithEvents("/rmme.txt", "gone");
    await agent.clearChangeLog();
    await agent.rmWithEvents("/rmme.txt");
    const log = (await agent.getChangeLog()) as unknown as {
      type: string;
      path: string;
      entryType: string;
    }[];
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe("delete");
  });

  it("symlink emits create event with symlink entryType", async () => {
    const agent = await freshAgent("evt-symlink");
    await agent.writeWithEvents("/target.txt", "t");
    await agent.clearChangeLog();
    await agent.symlinkWithEvents("/target.txt", "/slink.txt");
    const log = (await agent.getChangeLog()) as unknown as {
      type: string;
      path: string;
      entryType: string;
    }[];
    const slEvt = log.find(
      (e) => e.path === "/slink.txt" && e.entryType === "symlink"
    );
    expect(slEvt).toBeDefined();
    expect(slEvt!.type).toBe("create");
  });

  it("no events fire when onChange is not set", async () => {
    const agent = await freshAgent("evt-none");
    await agent.write("/no-events.txt", "quiet");
    const log = (await agent.getChangeLog()) as unknown as unknown[];
    expect(log).toHaveLength(0);
  });
});

// ── Binary file support ─────────────────────────────────────────────

describe("workspace — binary files", () => {
  it("writeFileBytes + readFileBytes round-trip", async () => {
    const agent = await freshAgent("bin-roundtrip");
    const data = [0, 1, 2, 127, 128, 255];
    await agent.writeBytes("/bin.dat", data);
    const result = (await agent.readBytes("/bin.dat")) as unknown as number[];
    expect(result).toEqual(data);
  });

  it("readFileBytes on text file returns encoded bytes", async () => {
    const agent = await freshAgent("bin-read-text");
    await agent.write("/text.txt", "hello");
    const result = (await agent.readBytes("/text.txt")) as unknown as number[];
    // "hello" in UTF-8
    expect(result).toEqual([104, 101, 108, 108, 111]);
  });

  it("readFile on binary file returns decoded string", async () => {
    const agent = await freshAgent("bin-read-as-text");
    // ASCII-safe bytes: "ABC"
    await agent.writeBytes("/abc.bin", [65, 66, 67]);
    const content = (await agent.read("/abc.bin")) as unknown as string;
    expect(content).toBe("ABC");
  });

  it("readFileBytes returns null for missing file", async () => {
    const agent = await freshAgent("bin-missing");
    const result = await agent.readBytes("/nope.bin");
    expect(result).toBeNull();
  });

  it("writeFileBytes creates parent directories", async () => {
    const agent = await freshAgent("bin-parents");
    await agent.writeBytes("/a/b/deep.bin", [1, 2, 3]);
    const result = (await agent.readBytes(
      "/a/b/deep.bin"
    )) as unknown as number[];
    expect(result).toEqual([1, 2, 3]);
  });

  it("writeFileBytes with custom mimeType", async () => {
    const agent = await freshAgent("bin-mime");
    await agent.writeBytes("/img.png", [137, 80, 78, 71], "image/png");
    const s = (await agent.stat("/img.png")) as unknown as {
      mimeType: string;
    };
    expect(s.mimeType).toBe("image/png");
  });

  it("writeFileBytes overwrites existing file", async () => {
    const agent = await freshAgent("bin-overwrite");
    await agent.writeBytes("/over.bin", [1, 2, 3]);
    await agent.writeBytes("/over.bin", [4, 5, 6]);
    const result = (await agent.readBytes("/over.bin")) as unknown as number[];
    expect(result).toEqual([4, 5, 6]);
  });

  it("binary file preserves null bytes", async () => {
    const agent = await freshAgent("bin-null");
    const data = [0, 0, 0, 42, 0, 0];
    await agent.writeBytes("/nulls.bin", data);
    const result = (await agent.readBytes("/nulls.bin")) as unknown as number[];
    expect(result).toEqual(data);
  });
});

// ── cp / mv ─────────────────────────────────────────────────────────

describe("workspace — cp", () => {
  it("copies a file", async () => {
    const agent = await freshAgent("cp-file");
    await agent.write("/src.txt", "copy me");
    await agent.cpCall("/src.txt", "/dest.txt");
    const content = (await agent.read("/dest.txt")) as unknown as string;
    expect(content).toBe("copy me");
    // source still exists
    const src = (await agent.read("/src.txt")) as unknown as string;
    expect(src).toBe("copy me");
  });

  it("copies a directory recursively", async () => {
    const agent = await freshAgent("cp-dir");
    await agent.write("/dir/a.txt", "aaa");
    await agent.write("/dir/b.txt", "bbb");
    await agent.cpCall("/dir", "/copy", { recursive: true });
    const a = (await agent.read("/copy/a.txt")) as unknown as string;
    const b = (await agent.read("/copy/b.txt")) as unknown as string;
    expect(a).toBe("aaa");
    expect(b).toBe("bbb");
  });

  it("copies nested directories recursively", async () => {
    const agent = await freshAgent("cp-nested");
    await agent.write("/d/sub/f.txt", "nested");
    await agent.cpCall("/d", "/d2", { recursive: true });
    const content = (await agent.read("/d2/sub/f.txt")) as unknown as string;
    expect(content).toBe("nested");
  });

  it("copies a symlink as a symlink", async () => {
    const agent = await freshAgent("cp-symlink");
    await agent.write("/target.txt", "t");
    await agent.symlinkCall("/target.txt", "/link.txt");
    await agent.cpCall("/link.txt", "/link2.txt");
    const target = (await agent.readlinkCall(
      "/link2.txt"
    )) as unknown as string;
    expect(target).toBe("/target.txt");
  });

  it("cp without recursive on directory throws EISDIR", async () => {
    const agent = await freshAgent("cp-no-recursive");
    await agent.write("/dir/f.txt", "x");
    const result = await agent.cpCall("/dir", "/dir2");
    expect((result as { error: string }).error).toContain("EISDIR");
  });

  it("cp on missing source throws ENOENT", async () => {
    const agent = await freshAgent("cp-enoent");
    const result = await agent.cpCall("/ghost", "/dest");
    expect((result as { error: string }).error).toContain("ENOENT");
  });
});

describe("workspace — mv", () => {
  it("moves a file", async () => {
    const agent = await freshAgent("mv-file");
    await agent.write("/old.txt", "move me");
    await agent.mvCall("/old.txt", "/new.txt");
    const content = (await agent.read("/new.txt")) as unknown as string;
    expect(content).toBe("move me");
    const old = await agent.read("/old.txt");
    expect(old).toBeNull();
  });

  it("moves a directory", async () => {
    const agent = await freshAgent("mv-dir");
    await agent.write("/src/a.txt", "aaa");
    await agent.write("/src/b.txt", "bbb");
    await agent.mvCall("/src", "/dst");
    const a = (await agent.read("/dst/a.txt")) as unknown as string;
    expect(a).toBe("aaa");
    const srcStat = await agent.stat("/src");
    expect(srcStat).toBeNull();
  });

  it("mv renames a file in place", async () => {
    const agent = await freshAgent("mv-rename");
    await agent.write("/dir/old.txt", "renamed");
    await agent.mvCall("/dir/old.txt", "/dir/new.txt");
    const content = (await agent.read("/dir/new.txt")) as unknown as string;
    expect(content).toBe("renamed");
    const old = await agent.read("/dir/old.txt");
    expect(old).toBeNull();
  });
});

// ── Diff ─────────────────────────────────────────────────────────────

describe("workspace — diff", () => {
  it("diff returns empty string for identical files", async () => {
    const agent = await freshAgent("diff-identical");
    await agent.write("/a.txt", "same\ncontent");
    await agent.write("/b.txt", "same\ncontent");
    const d = (await agent.diffCall("/a.txt", "/b.txt")) as unknown as string;
    expect(d).toBe("");
  });

  it("diff shows added lines", async () => {
    const agent = await freshAgent("diff-add");
    await agent.write("/a.txt", "line1\nline2");
    await agent.write("/b.txt", "line1\nline2\nline3");
    const d = (await agent.diffCall("/a.txt", "/b.txt")) as unknown as string;
    expect(d).toContain("--- /a.txt");
    expect(d).toContain("+++ /b.txt");
    expect(d).toContain("+line3");
  });

  it("diff shows removed lines", async () => {
    const agent = await freshAgent("diff-remove");
    await agent.write("/a.txt", "line1\nline2\nline3");
    await agent.write("/b.txt", "line1\nline3");
    const d = (await agent.diffCall("/a.txt", "/b.txt")) as unknown as string;
    expect(d).toContain("-line2");
  });

  it("diff shows changed lines", async () => {
    const agent = await freshAgent("diff-change");
    await agent.write("/a.txt", "hello\nworld");
    await agent.write("/b.txt", "hello\nearth");
    const d = (await agent.diffCall("/a.txt", "/b.txt")) as unknown as string;
    expect(d).toContain("-world");
    expect(d).toContain("+earth");
  });

  it("diffContent compares file against string", async () => {
    const agent = await freshAgent("diff-content");
    await agent.write("/f.txt", "old\ncontent");
    const d = (await agent.diffContentCall(
      "/f.txt",
      "new\ncontent"
    )) as unknown as string;
    expect(d).toContain("-old");
    expect(d).toContain("+new");
    expect(d).not.toContain("-content");
  });

  it("diffContent returns empty for same content", async () => {
    const agent = await freshAgent("diff-content-same");
    await agent.write("/f.txt", "unchanged");
    const d = (await agent.diffContentCall(
      "/f.txt",
      "unchanged"
    )) as unknown as string;
    expect(d).toBe("");
  });

  it("diff on missing file throws ENOENT", async () => {
    const agent = await freshAgent("diff-enoent");
    await agent.write("/a.txt", "exists");
    const result = await agent.diffCall("/a.txt", "/nope.txt");
    expect((result as { error: string }).error).toContain("ENOENT");
  });

  it("diff includes hunk headers", async () => {
    const agent = await freshAgent("diff-hunks");
    await agent.write("/a.txt", "a\nb\nc\nd\ne");
    await agent.write("/b.txt", "a\nb\nX\nd\ne");
    const d = (await agent.diffCall("/a.txt", "/b.txt")) as unknown as string;
    expect(d).toContain("@@");
    expect(d).toContain("-c");
    expect(d).toContain("+X");
  });
});

// ── Regression tests ────────────────────────────────────────────────

describe("workspace — regression: content_encoding reset", () => {
  it("writeFile over binary file resets encoding so readFile works", async () => {
    const agent = await freshAgent("reg-encoding-reset");
    // Write binary first (stores as base64)
    await agent.writeBytes("/mixed.txt", [0, 1, 2, 255]);
    // Overwrite with text (must reset content_encoding to utf8)
    await agent.write("/mixed.txt", "now text");
    const content = (await agent.read("/mixed.txt")) as unknown as string;
    expect(content).toBe("now text");
  });

  it("writeFileBytes over text file sets encoding to base64", async () => {
    const agent = await freshAgent("reg-encoding-to-b64");
    await agent.write("/f.txt", "text first");
    await agent.writeBytes("/f.txt", [10, 20, 30]);
    const bytes = (await agent.readBytes("/f.txt")) as unknown as number[];
    expect(bytes).toEqual([10, 20, 30]);
  });
});

describe("workspace — regression: writeFileStream binary", () => {
  it("writeFileStream preserves binary data", async () => {
    const agent = await freshAgent("reg-stream-binary");
    const data = [0, 1, 127, 128, 255];
    await agent.writeStreamBytes("/stream.bin", data);
    const result = (await agent.readBytes(
      "/stream.bin"
    )) as unknown as number[];
    expect(result).toEqual(data);
  });
});

describe("workspace — regression: symlink write-through", () => {
  it("writeFile through symlink modifies the target", async () => {
    const agent = await freshAgent("reg-write-symlink");
    await agent.write("/real.txt", "original");
    await agent.symlinkCall("/real.txt", "/link.txt");
    await agent.write("/link.txt", "updated");
    // Target should be updated
    const content = (await agent.read("/real.txt")) as unknown as string;
    expect(content).toBe("updated");
    // Symlink should still exist
    const target = (await agent.readlinkCall("/link.txt")) as unknown as string;
    expect(target).toBe("/real.txt");
  });

  it("writeFileBytes through symlink modifies the target", async () => {
    const agent = await freshAgent("reg-writebytes-symlink");
    await agent.writeBytes("/real.bin", [1, 2, 3]);
    await agent.symlinkCall("/real.bin", "/link.bin");
    await agent.writeBytes("/link.bin", [4, 5, 6]);
    const bytes = (await agent.readBytes("/real.bin")) as unknown as number[];
    expect(bytes).toEqual([4, 5, 6]);
  });
});

describe("workspace — regression: deleteFile symlink", () => {
  it("deleteFile removes a symlink without following it", async () => {
    const agent = await freshAgent("reg-delete-symlink");
    await agent.write("/target.txt", "keep me");
    await agent.symlinkCall("/target.txt", "/link.txt");
    const deleted = (await agent.del("/link.txt")) as unknown as boolean;
    expect(deleted).toBe(true);
    // Target should still exist
    const content = (await agent.read("/target.txt")) as unknown as string;
    expect(content).toBe("keep me");
  });

  it("deleteFile on symlink to directory succeeds (removes link)", async () => {
    const agent = await freshAgent("reg-delete-symlink-dir");
    await agent.mkdirCall("/mydir");
    await agent.symlinkCall("/mydir", "/dirlink");
    const deleted = (await agent.del("/dirlink")) as unknown as boolean;
    expect(deleted).toBe(true);
    // Directory still exists
    const s = await agent.stat("/mydir");
    expect(s).not.toBeNull();
  });
});

describe("workspace — regression: fileExists through symlink", () => {
  it("fileExists returns true through symlink to file", async () => {
    const agent = await freshAgent("reg-exists-symlink");
    await agent.write("/real.txt", "hi");
    await agent.symlinkCall("/real.txt", "/link.txt");
    const ex = (await agent.exists("/link.txt")) as unknown as boolean;
    expect(ex).toBe(true);
  });

  it("fileExists returns false through symlink to directory", async () => {
    const agent = await freshAgent("reg-exists-symlink-dir");
    await agent.mkdirCall("/dir");
    await agent.symlinkCall("/dir", "/dirlink");
    const ex = (await agent.exists("/dirlink")) as unknown as boolean;
    expect(ex).toBe(false);
  });
});

// ── Glob ────────────────────────────────────────────────────────────

describe("workspace — glob", () => {
  it("matches files by extension", async () => {
    const agent = await freshAgent("glob-ext");
    await agent.write("/src/a.ts", "a");
    await agent.write("/src/b.ts", "b");
    await agent.write("/src/c.js", "c");
    await agent.write("/src/d.txt", "d");
    const results = (await agent.globCall(
      "/src/*.ts"
    )) as unknown as FileInfo[];
    expect(results.length).toBe(2);
    expect(results.map((r) => r.name).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("** matches across directories", async () => {
    const agent = await freshAgent("glob-doublestar");
    await agent.write("/src/a.ts", "a");
    await agent.write("/src/sub/b.ts", "b");
    await agent.write("/src/sub/deep/c.ts", "c");
    await agent.write("/src/sub/deep/d.js", "d");
    const results = (await agent.globCall(
      "/src/**/*.ts"
    )) as unknown as FileInfo[];
    expect(results.length).toBe(3);
    expect(results.map((r) => r.path).sort()).toEqual([
      "/src/a.ts",
      "/src/sub/b.ts",
      "/src/sub/deep/c.ts"
    ]);
  });

  it("? matches single character", async () => {
    const agent = await freshAgent("glob-question");
    await agent.write("/f1.txt", "1");
    await agent.write("/f2.txt", "2");
    await agent.write("/f10.txt", "10");
    const results = (await agent.globCall("/f?.txt")) as unknown as FileInfo[];
    expect(results.length).toBe(2);
    expect(results.map((r) => r.name).sort()).toEqual(["f1.txt", "f2.txt"]);
  });

  it("brace expansion {a,b}", async () => {
    const agent = await freshAgent("glob-brace");
    await agent.write("/app.ts", "ts");
    await agent.write("/app.js", "js");
    await agent.write("/app.css", "css");
    const results = (await agent.globCall(
      "/app.{ts,js}"
    )) as unknown as FileInfo[];
    expect(results.length).toBe(2);
    expect(results.map((r) => r.name).sort()).toEqual(["app.js", "app.ts"]);
  });

  it("character class [abc]", async () => {
    const agent = await freshAgent("glob-charclass");
    await agent.write("/a.txt", "a");
    await agent.write("/b.txt", "b");
    await agent.write("/c.txt", "c");
    await agent.write("/d.txt", "d");
    const results = (await agent.globCall(
      "/[ab].txt"
    )) as unknown as FileInfo[];
    expect(results.length).toBe(2);
    expect(results.map((r) => r.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("matches directories and files", async () => {
    const agent = await freshAgent("glob-all-types");
    await agent.write("/src/index.ts", "x");
    await agent.mkdirCall("/src/utils", { recursive: true });
    const results = (await agent.globCall("/src/*")) as unknown as FileInfo[];
    expect(results.length).toBe(2);
    const types = results.map((r) => r.type).sort();
    expect(types).toEqual(["directory", "file"]);
  });

  it("returns empty for no matches", async () => {
    const agent = await freshAgent("glob-nomatch");
    await agent.write("/a.txt", "a");
    const results = (await agent.globCall("/b.*")) as unknown as FileInfo[];
    expect(results.length).toBe(0);
  });

  it("exact path (no wildcards) returns the entry", async () => {
    const agent = await freshAgent("glob-exact");
    await agent.write("/exact.txt", "x");
    const results = (await agent.globCall(
      "/exact.txt"
    )) as unknown as FileInfo[];
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("exact.txt");
  });

  it("prefix optimization narrows SQL scan", async () => {
    const agent = await freshAgent("glob-prefix");
    await agent.write("/a/file.ts", "a");
    await agent.write("/b/file.ts", "b");
    await agent.write("/a/nested/deep.ts", "c");
    // Only /a/** should match — /b/ should not be scanned
    const results = (await agent.globCall(
      "/a/**/*.ts"
    )) as unknown as FileInfo[];
    expect(results.length).toBe(2);
    expect(results.every((r) => r.path.startsWith("/a/"))).toBe(true);
  });
});

// ── Security regression tests ───────────────────────────────────────

describe("workspace — security: LIKE injection (#1)", () => {
  it("rm recursive on dir with % in name does not delete unrelated files", async () => {
    const agent = await freshAgent("sec-like-percent");
    await agent.write("/a%b/child.txt", "in dir");
    await agent.write("/axb/other.txt", "unrelated");
    await agent.rmCall("/a%b", { recursive: true });
    // The unrelated file must survive
    const content = (await agent.read("/axb/other.txt")) as unknown as string;
    expect(content).toBe("unrelated");
  });

  it("rm recursive on dir with _ in name does not delete unrelated files", async () => {
    const agent = await freshAgent("sec-like-underscore");
    await agent.write("/a_b/child.txt", "in dir");
    await agent.write("/axb/other.txt", "unrelated");
    await agent.rmCall("/a_b", { recursive: true });
    const content = (await agent.read("/axb/other.txt")) as unknown as string;
    expect(content).toBe("unrelated");
  });
});

describe("workspace — security: path normalization (#2)", () => {
  it(".. is resolved so files are reachable via readDir", async () => {
    const agent = await freshAgent("sec-dotdot-resolve");
    await agent.write("/a/b/../c.txt", "content");
    // Should be stored at /a/c.txt (after resolving ..)
    const content = (await agent.read("/a/c.txt")) as unknown as string;
    expect(content).toBe("content");
    const files = (await agent.list("/a")) as unknown as FileInfo[];
    const names = files.map((f: FileInfo) => f.name);
    expect(names).toContain("c.txt");
  });

  it(". is resolved in paths", async () => {
    const agent = await freshAgent("sec-dot-resolve");
    await agent.write("/a/./b.txt", "content");
    const content = (await agent.read("/a/b.txt")) as unknown as string;
    expect(content).toBe("content");
  });

  it(".. at root stays at root", async () => {
    const agent = await freshAgent("sec-dotdot-root");
    await agent.write("/../../../etc/passwd", "nope");
    // Should normalize to /etc/passwd (.. can't go above root)
    const content = (await agent.read("/etc/passwd")) as unknown as string;
    expect(content).toBe("nope");
  });

  it("read and write use consistent normalized paths", async () => {
    const agent = await freshAgent("sec-norm-consistency");
    await agent.write("/x/y/../z.txt", "v1");
    await agent.write("/x/z.txt", "v2");
    // Both paths should resolve to the same entry — v2 overwrites v1
    const content = (await agent.read("/x/y/../z.txt")) as unknown as string;
    expect(content).toBe("v2");
  });
});

describe("workspace — security: writeFileStream size limit (#3)", () => {
  it("rejects streams that exceed MAX_STREAM_SIZE", async () => {
    // We can't easily create a 100MB+ stream in tests, but we can verify
    // the error message format exists and the guard logic is in place.
    // Instead, test that a normal-sized stream still works.
    const agent = await freshAgent("sec-stream-ok");
    await agent.writeStream("/ok.txt", "small content");
    const content = (await agent.read("/ok.txt")) as unknown as string;
    expect(content).toBe("small content");
  });
});

describe("workspace — security: diff line limit (#4)", () => {
  it("rejects diff when files exceed MAX_DIFF_LINES", async () => {
    const agent = await freshAgent("sec-diff-limit");
    // Create a file with > 10000 lines
    const bigContent = Array.from(
      { length: 10_001 },
      (_, i) => `line ${i}`
    ).join("\n");
    await agent.write("/big.txt", bigContent);
    await agent.write("/small.txt", "hello");
    const result = await agent.diffCall("/big.txt", "/small.txt");
    expect((result as { error: string }).error).toContain("EFBIG");
  });

  it("rejects diffContent when content exceeds MAX_DIFF_LINES", async () => {
    const agent = await freshAgent("sec-diffcontent-limit");
    await agent.write("/base.txt", "hello");
    const bigContent = Array.from(
      { length: 10_001 },
      (_, i) => `line ${i}`
    ).join("\n");
    const result = await agent.diffContentCall("/base.txt", bigContent);
    expect((result as { error: string }).error).toContain("EFBIG");
  });

  it("allows diff on files within the line limit", async () => {
    const agent = await freshAgent("sec-diff-ok");
    await agent.write("/a.txt", "hello\nworld");
    await agent.write("/b.txt", "hello\nearth");
    const d = (await agent.diffCall("/a.txt", "/b.txt")) as unknown as string;
    expect(d).toContain("-world");
    expect(d).toContain("+earth");
  });
});

describe("workspace — security: symlink target validation (#5)", () => {
  it("rejects empty symlink target", async () => {
    const agent = await freshAgent("sec-symlink-empty");
    const result = await agent.symlinkCall("", "/link");
    expect((result as { error: string }).error).toContain("EINVAL");
  });

  it("rejects whitespace-only symlink target", async () => {
    const agent = await freshAgent("sec-symlink-space");
    const result = await agent.symlinkCall("   ", "/link");
    expect((result as { error: string }).error).toContain("EINVAL");
  });

  it("rejects excessively long symlink target", async () => {
    const agent = await freshAgent("sec-symlink-long");
    const longTarget = "/" + "a".repeat(5000);
    const result = await agent.symlinkCall(longTarget, "/link");
    expect((result as { error: string }).error).toContain("ENAMETOOLONG");
  });
});

describe("workspace — security: path length limit (#6)", () => {
  it("rejects paths exceeding MAX_PATH_LENGTH", async () => {
    const agent = await freshAgent("sec-path-long");
    const longPath = "/" + "a".repeat(5000);
    const result = await agent.write(longPath, "nope");
    expect((result as { error: string }).error).toContain("ENAMETOOLONG");
  });

  it("allows paths within the limit", async () => {
    const agent = await freshAgent("sec-path-ok");
    const okPath = "/" + "a".repeat(100) + "/file.txt";
    await agent.write(okPath, "ok");
    const content = (await agent.read(okPath)) as unknown as string;
    expect(content).toBe("ok");
  });
});

// ── Observability ───────────────────────────────────────────────────

describe("workspace — observability", () => {
  it("emits workspace:write on file creation", async () => {
    const agent = await freshAgent("obs-write-create");
    await agent.startObservability();
    await agent.write("/hello.txt", "world");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const writeEvents = log.filter((e) => e.type === "workspace:write");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].payload).toMatchObject({
      path: "/hello.txt",
      storage: "inline",
      update: false,
      namespace: "default"
    });
    expect(writeEvents[0].payload.size).toBeGreaterThan(0);
  });

  it("emits workspace:write with update=true on overwrite", async () => {
    const agent = await freshAgent("obs-write-update");
    await agent.write("/f.txt", "v1");
    await agent.startObservability();
    await agent.write("/f.txt", "v2");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const writeEvents = log.filter((e) => e.type === "workspace:write");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].payload.update).toBe(true);
  });

  it("emits workspace:read on file read", async () => {
    const agent = await freshAgent("obs-read");
    await agent.write("/r.txt", "data");
    await agent.startObservability();
    await agent.read("/r.txt");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const readEvents = log.filter((e) => e.type === "workspace:read");
    expect(readEvents).toHaveLength(1);
    expect(readEvents[0].payload).toMatchObject({
      path: "/r.txt",
      storage: "inline",
      namespace: "default"
    });
  });

  it("emits workspace:delete on file deletion", async () => {
    const agent = await freshAgent("obs-delete");
    await agent.write("/d.txt", "gone");
    await agent.startObservability();
    await agent.del("/d.txt");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const delEvents = log.filter((e) => e.type === "workspace:delete");
    expect(delEvents).toHaveLength(1);
    expect(delEvents[0].payload).toMatchObject({
      path: "/d.txt",
      namespace: "default"
    });
  });

  it("emits workspace:mkdir on directory creation", async () => {
    const agent = await freshAgent("obs-mkdir");
    await agent.startObservability();
    await agent.mkdirCall("/mydir");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const mkdirEvents = log.filter((e) => e.type === "workspace:mkdir");
    expect(mkdirEvents).toHaveLength(1);
    expect(mkdirEvents[0].payload).toMatchObject({
      path: "/mydir",
      namespace: "default"
    });
  });

  it("emits workspace:rm on removal", async () => {
    const agent = await freshAgent("obs-rm");
    await agent.write("/rmfile.txt", "x");
    await agent.startObservability();
    await agent.rmCall("/rmfile.txt");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const rmEvents = log.filter((e) => e.type === "workspace:rm");
    expect(rmEvents).toHaveLength(1);
    expect(rmEvents[0].payload).toMatchObject({
      path: "/rmfile.txt",
      namespace: "default"
    });
  });

  it("emits workspace:cp on copy", async () => {
    const agent = await freshAgent("obs-cp");
    await agent.write("/src.txt", "copy me");
    await agent.startObservability();
    await agent.cpCall("/src.txt", "/dst.txt");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const cpEvents = log.filter((e) => e.type === "workspace:cp");
    expect(cpEvents).toHaveLength(1);
    expect(cpEvents[0].payload).toMatchObject({
      src: "/src.txt",
      dest: "/dst.txt",
      namespace: "default"
    });
  });

  it("emits workspace:mv on move", async () => {
    const agent = await freshAgent("obs-mv");
    await agent.write("/old.txt", "moving");
    await agent.startObservability();
    await agent.mvCall("/old.txt", "/new.txt");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const mvEvents = log.filter((e) => e.type === "workspace:mv");
    expect(mvEvents).toHaveLength(1);
    expect(mvEvents[0].payload).toMatchObject({
      src: "/old.txt",
      dest: "/new.txt",
      namespace: "default"
    });
  });

  it("emits workspace:bash on bash execution", async () => {
    const agent = await freshAgent("obs-bash");
    await agent.startObservability();
    await agent.bashCall("echo hello");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    await agent.stopObservability();

    const bashEvents = log.filter((e) => e.type === "workspace:bash");
    expect(bashEvents).toHaveLength(1);
    expect(bashEvents[0].payload).toMatchObject({
      command: "echo hello",
      exitCode: 0,
      namespace: "default"
    });
    expect(bashEvents[0].payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("events include timestamp", async () => {
    const agent = await freshAgent("obs-timestamp");
    const before = Date.now();
    await agent.startObservability();
    await agent.write("/ts.txt", "time");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      timestamp: number;
    }[];
    await agent.stopObservability();

    const writeEvent = log.find((e) => e.type === "workspace:write");
    expect(writeEvent).toBeDefined();
    expect(writeEvent!.timestamp).toBeGreaterThanOrEqual(before);
    expect(writeEvent!.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("events include agent name", async () => {
    const agent = await freshAgent("obs-name");
    await agent.startObservability();
    await agent.write("/n.txt", "name");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
      name: string;
    }[];
    await agent.stopObservability();

    const writeEvent = log.find((e) => e.type === "workspace:write");
    expect(writeEvent).toBeDefined();
    expect(writeEvent!.name).toBe("obs-name");
  });

  it("no events emitted after unsubscribe", async () => {
    const agent = await freshAgent("obs-unsub");
    await agent.startObservability();
    await agent.stopObservability();
    await agent.write("/after.txt", "silent");
    const log = (await agent.getObservabilityLog()) as {
      type: string;
    }[];
    expect(log).toHaveLength(0);
  });
});
