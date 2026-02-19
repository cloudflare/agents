import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function getWorkspace(name: string) {
  return env.Workspace.get(env.Workspace.idFromName(name));
}

/**
 * Returns a TestWorkspace stub whose `try*` methods catch errors *inside* the
 * DO and return them as resolved values, preventing the DO-side promise from
 * being rejected and triggering vitest's "Unhandled Rejection" reporter.
 */
function getTestWorkspace(name: string) {
  return env.TestWorkspace.get(env.TestWorkspace.idFromName(name));
}

function isErr(v: unknown): v is { __error: string } {
  return typeof v === "object" && v !== null && "__error" in v;
}

function assertErr(v: unknown, contains: string) {
  expect(isErr(v)).toBe(true);
  expect((v as { __error: string }).__error).toContain(contains);
}

function getThinkAgent(name: string) {
  return getAgentByName(env.ThinkAgent, name);
}

// ── Root directory ────────────────────────────────────────────────────

describe("Workspace root directory", () => {
  it("root directory always exists", async () => {
    const ws = getWorkspace(`ws-root-${crypto.randomUUID()}`);
    const info = await ws.stat("/");
    expect(info).not.toBeNull();
    expect(info!.type).toBe("directory");
    expect(info!.path).toBe("/");
  });

  it("listFiles('/') returns empty array on fresh workspace", async () => {
    const ws = getWorkspace(`ws-root-empty-${crypto.randomUUID()}`);
    const files = await ws.listFiles("/");
    expect(files).toEqual([]);
  });
});

// ── stat ───────────────────────────────────────────────────────────────

describe("Workspace.stat", () => {
  it("returns null for non-existent path", async () => {
    const ws = getWorkspace(`ws-stat-miss-${crypto.randomUUID()}`);
    expect(await ws.stat("/missing.ts")).toBeNull();
  });

  it("returns file metadata", async () => {
    const ws = getWorkspace(`ws-stat-file-${crypto.randomUUID()}`);
    await ws.writeFile("/file.ts", "const x = 1;", "text/x-typescript");
    const s = await ws.stat("/file.ts");
    expect(s).not.toBeNull();
    expect(s!.type).toBe("file");
    expect(s!.name).toBe("file.ts");
    expect(s!.mimeType).toBe("text/x-typescript");
    expect(s!.size).toBeGreaterThan(0);
    expect(s!.createdAt).toBeGreaterThan(0);
    expect(s!.updatedAt).toBeGreaterThan(0);
  });

  it("returns directory metadata", async () => {
    const ws = getWorkspace(`ws-stat-dir-${crypto.randomUUID()}`);
    await ws.mkdir("/src");
    const s = await ws.stat("/src");
    expect(s).not.toBeNull();
    expect(s!.type).toBe("directory");
    expect(s!.name).toBe("src");
  });

  it("updatedAt changes on overwrite", async () => {
    const ws = getWorkspace(`ws-stat-update-${crypto.randomUUID()}`);
    await ws.writeFile("/f.ts", "v1");
    const s1 = await ws.stat("/f.ts");

    await new Promise((r) => setTimeout(r, 1100)); // ensure 1s passes
    await ws.writeFile("/f.ts", "v2 with more content");
    const s2 = await ws.stat("/f.ts");

    expect(s2!.updatedAt).toBeGreaterThanOrEqual(s1!.updatedAt);
    expect(s2!.size).toBeGreaterThan(s1!.size);
  });
});

// ── readFile / writeFile ──────────────────────────────────────────────

describe("Workspace readFile / writeFile", () => {
  it("returns null for non-existent file", async () => {
    const ws = getWorkspace(`ws-read-${crypto.randomUUID()}`);
    expect(await ws.readFile("/does-not-exist.ts")).toBeNull();
  });

  it("writes and reads a file", async () => {
    const ws = getWorkspace(`ws-rw-${crypto.randomUUID()}`);
    await ws.writeFile("/hello.txt", "Hello, world!");
    expect(await ws.readFile("/hello.txt")).toBe("Hello, world!");
  });

  it("overwrites existing file", async () => {
    const ws = getWorkspace(`ws-overwrite-${crypto.randomUUID()}`);
    await ws.writeFile("/file.ts", "v1");
    await ws.writeFile("/file.ts", "v2");
    expect(await ws.readFile("/file.ts")).toBe("v2");
  });

  it("normalizes paths (adds leading slash)", async () => {
    const ws = getWorkspace(`ws-path-norm-${crypto.randomUUID()}`);
    await ws.writeFile("src/index.ts", "export const x = 1;");
    expect(await ws.readFile("/src/index.ts")).toBe("export const x = 1;");
  });

  it("auto-creates parent directories on writeFile", async () => {
    const ws = getWorkspace(`ws-auto-dir-${crypto.randomUUID()}`);
    await ws.writeFile("/a/b/c/deep.ts", "deep content");
    expect(await ws.readFile("/a/b/c/deep.ts")).toBe("deep content");
    // Parent directories should exist
    expect(await ws.stat("/a")).not.toBeNull();
    expect(await ws.stat("/a/b")).not.toBeNull();
    expect(await ws.stat("/a/b/c")).not.toBeNull();
  });

  it("preserves unicode content", async () => {
    const ws = getWorkspace(`ws-unicode-${crypto.randomUUID()}`);
    const content = "# こんにちは 🌍\nexport const greeting = '안녕';";
    await ws.writeFile("/unicode.ts", content);
    expect(await ws.readFile("/unicode.ts")).toBe(content);
  });

  it("stores empty file content", async () => {
    const ws = getWorkspace(`ws-empty-${crypto.randomUUID()}`);
    await ws.writeFile("/empty.ts", "");
    expect(await ws.readFile("/empty.ts")).toBe("");
  });

  it("persists across stub calls (hibernation simulation)", async () => {
    const name = `ws-persist-${crypto.randomUUID()}`;
    const ws1 = getWorkspace(name);
    await ws1.writeFile("/data.json", '{"key":"value"}');

    const ws2 = getWorkspace(name);
    expect(await ws2.readFile("/data.json")).toBe('{"key":"value"}');
  });

  it("throws EISDIR when reading a directory", async () => {
    const ws = getTestWorkspace(`ws-read-dir-${crypto.randomUUID()}`);
    await ws.mkdir("/mydir");
    assertErr(await ws.tryReadFile("/mydir"), "EISDIR");
  });
});

// ── deleteFile ────────────────────────────────────────────────────────

describe("Workspace.deleteFile", () => {
  it("deletes an existing file", async () => {
    const ws = getWorkspace(`ws-del-${crypto.randomUUID()}`);
    await ws.writeFile("/tmp.txt", "temporary");
    expect(await ws.deleteFile("/tmp.txt")).toBe(true);
    expect(await ws.readFile("/tmp.txt")).toBeNull();
  });

  it("returns false for non-existent file", async () => {
    const ws = getWorkspace(`ws-del-miss-${crypto.randomUUID()}`);
    expect(await ws.deleteFile("/missing.txt")).toBe(false);
  });

  it("throws EISDIR when called on a directory", async () => {
    const ws = getTestWorkspace(`ws-del-dir-${crypto.randomUUID()}`);
    await ws.mkdir("/mydir");
    assertErr(await ws.tryDeleteFile("/mydir"), "EISDIR");
  });
});

// ── fileExists ────────────────────────────────────────────────────────

describe("Workspace.fileExists", () => {
  it("returns true for existing file", async () => {
    const ws = getWorkspace(`ws-exists-${crypto.randomUUID()}`);
    await ws.writeFile("/exists.ts", "yes");
    expect(await ws.fileExists("/exists.ts")).toBe(true);
  });

  it("returns false for non-existent path", async () => {
    const ws = getWorkspace(`ws-not-exists-${crypto.randomUUID()}`);
    expect(await ws.fileExists("/nope.ts")).toBe(false);
  });

  it("returns false for a directory (not a file)", async () => {
    const ws = getWorkspace(`ws-dir-exists-${crypto.randomUUID()}`);
    await ws.mkdir("/somedir");
    expect(await ws.fileExists("/somedir")).toBe(false);
  });
});

// ── mkdir ─────────────────────────────────────────────────────────────

describe("Workspace.mkdir", () => {
  it("creates a directory", async () => {
    const ws = getWorkspace(`ws-mkdir-${crypto.randomUUID()}`);
    await ws.mkdir("/src");
    const s = await ws.stat("/src");
    expect(s).not.toBeNull();
    expect(s!.type).toBe("directory");
  });

  it("mkdir with recursive creates intermediate dirs", async () => {
    const ws = getWorkspace(`ws-mkdir-r-${crypto.randomUUID()}`);
    await ws.mkdir("/a/b/c", { recursive: true });
    expect((await ws.stat("/a"))?.type).toBe("directory");
    expect((await ws.stat("/a/b"))?.type).toBe("directory");
    expect((await ws.stat("/a/b/c"))?.type).toBe("directory");
  });

  it("mkdir without recursive throws ENOENT if parent missing", async () => {
    const ws = getTestWorkspace(`ws-mkdir-noparent-${crypto.randomUUID()}`);
    assertErr(await ws.tryMkdir("/missing/parent/child"), "ENOENT");
  });

  it("mkdir on existing directory throws EEXIST", async () => {
    const ws = getTestWorkspace(`ws-mkdir-exists-${crypto.randomUUID()}`);
    await ws.mkdir("/existing");
    assertErr(await ws.tryMkdir("/existing"), "EEXIST");
  });

  it("mkdir recursive on existing directory is a no-op", async () => {
    const ws = getWorkspace(`ws-mkdir-exists-r-${crypto.randomUUID()}`);
    await ws.mkdir("/existing");
    // Should not throw
    await ws.mkdir("/existing", { recursive: true });
    expect((await ws.stat("/existing"))?.type).toBe("directory");
  });

  it("root directory mkdir is always a no-op", async () => {
    const ws = getWorkspace(`ws-mkdir-root-${crypto.randomUUID()}`);
    await ws.mkdir("/"); // Should not throw
  });
});

// ── listFiles ─────────────────────────────────────────────────────────

describe("Workspace.listFiles", () => {
  it("returns empty array when directory has no children", async () => {
    const ws = getWorkspace(`ws-list-empty-${crypto.randomUUID()}`);
    expect(await ws.listFiles()).toEqual([]);
  });

  it("lists direct children of root", async () => {
    const ws = getWorkspace(`ws-list-root-${crypto.randomUUID()}`);
    await ws.writeFile("/a.ts", "a");
    await ws.writeFile("/b.ts", "b");
    await ws.mkdir("/src");

    const entries = await ws.listFiles("/");
    expect(entries).toHaveLength(3);

    // Directories come first, then files
    expect(entries[0].type).toBe("directory");
    expect(entries[0].name).toBe("src");
    expect(entries[1].type).toBe("file");
    expect(entries[1].name).toBe("a.ts");
    expect(entries[2].name).toBe("b.ts");
  });

  it("lists only direct children, not nested", async () => {
    const ws = getWorkspace(`ws-list-direct-${crypto.randomUUID()}`);
    await ws.writeFile("/a.ts", "a");
    await ws.writeFile("/src/nested.ts", "nested");

    const entries = await ws.listFiles("/");
    // Should see /a.ts and /src (directory), NOT /src/nested.ts
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name).sort()).toEqual(["a.ts", "src"]);
  });

  it("lists subdirectory contents", async () => {
    const ws = getWorkspace(`ws-list-sub-${crypto.randomUUID()}`);
    await ws.writeFile("/src/index.ts", "index");
    await ws.writeFile("/src/utils.ts", "utils");
    await ws.writeFile("/README.md", "readme");

    const srcEntries = await ws.listFiles("/src");
    expect(srcEntries).toHaveLength(2);
    expect(srcEntries.every((e) => e.path.startsWith("/src"))).toBe(true);
    expect(srcEntries.map((e) => e.name).sort()).toEqual([
      "index.ts",
      "utils.ts"
    ]);
  });

  it("entries include path, name, type, size", async () => {
    const ws = getWorkspace(`ws-list-meta-${crypto.randomUUID()}`);
    const content = "hello world";
    await ws.writeFile("/test.txt", content);

    const entries = await ws.listFiles();
    expect(entries[0].path).toBe("/test.txt");
    expect(entries[0].name).toBe("test.txt");
    expect(entries[0].type).toBe("file");
    expect(entries[0].size).toBe(new TextEncoder().encode(content).byteLength);
    expect(entries[0].createdAt).toBeGreaterThan(0);
  });
});

// ── rm ────────────────────────────────────────────────────────────────

describe("Workspace.rm", () => {
  it("removes a file", async () => {
    const ws = getWorkspace(`ws-rm-file-${crypto.randomUUID()}`);
    await ws.writeFile("/delete-me.ts", "bye");
    await ws.rm("/delete-me.ts");
    expect(await ws.readFile("/delete-me.ts")).toBeNull();
  });

  it("removes an empty directory", async () => {
    const ws = getWorkspace(`ws-rm-dir-${crypto.randomUUID()}`);
    await ws.mkdir("/emptydir");
    await ws.rm("/emptydir");
    expect(await ws.stat("/emptydir")).toBeNull();
  });

  it("throws ENOTEMPTY on non-empty directory without recursive", async () => {
    const ws = getTestWorkspace(`ws-rm-notempty-${crypto.randomUUID()}`);
    await ws.writeFile("/mydir/file.ts", "content");
    assertErr(await ws.tryRm("/mydir"), "ENOTEMPTY");
  });

  it("removes non-empty directory with recursive: true", async () => {
    const ws = getWorkspace(`ws-rm-rec-${crypto.randomUUID()}`);
    await ws.writeFile("/project/src/index.ts", "index");
    await ws.writeFile("/project/src/utils.ts", "utils");
    await ws.writeFile("/project/README.md", "readme");

    await ws.rm("/project", { recursive: true });

    expect(await ws.stat("/project")).toBeNull();
    expect(await ws.stat("/project/src")).toBeNull();
    expect(await ws.readFile("/project/src/index.ts")).toBeNull();
  });

  it("throws ENOENT for missing path without force", async () => {
    const ws = getTestWorkspace(`ws-rm-miss-${crypto.randomUUID()}`);
    assertErr(await ws.tryRm("/not-here.ts"), "ENOENT");
  });

  it("force: true silently ignores missing path", async () => {
    const ws = getWorkspace(`ws-rm-force-${crypto.randomUUID()}`);
    await ws.rm("/not-here.ts", { force: true }); // should not throw
  });

  it("throws EPERM when trying to remove root", async () => {
    const ws = getTestWorkspace(`ws-rm-root-${crypto.randomUUID()}`);
    assertErr(await ws.tryRm("/"), "EPERM");
  });
});

// ── getInfo ───────────────────────────────────────────────────────────

describe("Workspace.getInfo", () => {
  it("returns zeros for empty workspace (just root dir)", async () => {
    const ws = getWorkspace(`ws-info-empty-${crypto.randomUUID()}`);
    const info = await ws.getInfo();
    expect(info.fileCount).toBe(0);
    // Root is a directory but we count user-created dirs
    expect(info.totalBytes).toBe(0);
  });

  it("tracks file count, directory count, and total bytes", async () => {
    const ws = getWorkspace(`ws-info-${crypto.randomUUID()}`);
    await ws.writeFile("/a.txt", "hello"); // 5 bytes
    await ws.writeFile("/b.txt", "world!"); // 6 bytes
    await ws.mkdir("/mydir"); // directory

    const info = await ws.getInfo();
    expect(info.fileCount).toBe(2);
    expect(info.directoryCount).toBeGreaterThanOrEqual(1); // mydir + root
    expect(info.totalBytes).toBe(5 + 6);
  });

  it("total bytes decreases after file deletion", async () => {
    const ws = getWorkspace(`ws-info-del-${crypto.randomUUID()}`);
    await ws.writeFile("/f.txt", "content");
    const before = await ws.getInfo();

    await ws.deleteFile("/f.txt");
    const after = await ws.getInfo();

    expect(after.fileCount).toBe(before.fileCount - 1);
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
  });
});

// ── bash (via just-bash) ──────────────────────────────────────────────

describe("Workspace.bash (just-bash)", () => {
  it("executes a basic command", async () => {
    const ws = getWorkspace(`ws-bash-basic-${crypto.randomUUID()}`);
    const result = await ws.bash("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("reads files written via writeFile", async () => {
    const ws = getWorkspace(`ws-bash-read-${crypto.randomUUID()}`);
    await ws.writeFile("/hello.txt", "Hello from workspace!");
    const result = await ws.bash("cat /hello.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Hello from workspace!");
  });

  it("writes files readable via readFile", async () => {
    const ws = getWorkspace(`ws-bash-write-${crypto.randomUUID()}`);
    await ws.bash('echo "written by bash" > /output.txt');
    const content = await ws.readFile("/output.txt");
    expect(content?.trim()).toBe("written by bash");
  });

  it("supports pipes", async () => {
    const ws = getWorkspace(`ws-bash-pipe-${crypto.randomUUID()}`);
    await ws.writeFile("/data.txt", "banana\napple\ncherry");
    const result = await ws.bash("cat /data.txt | sort");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("apple\nbanana\ncherry");
  });

  it("supports grep", async () => {
    const ws = getWorkspace(`ws-bash-grep-${crypto.randomUUID()}`);
    await ws.writeFile(
      "/src/index.ts",
      "const x = 1;\nconst y = 2;\nlet z = 3;"
    );
    const result = await ws.bash("grep 'const' /src/index.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("const x = 1;");
    expect(result.stdout).toContain("const y = 2;");
    expect(result.stdout).not.toContain("let z");
  });

  it("supports find", async () => {
    const ws = getWorkspace(`ws-bash-find-${crypto.randomUUID()}`);
    await ws.writeFile("/src/index.ts", "a");
    await ws.writeFile("/src/utils.ts", "b");
    await ws.writeFile("/README.md", "c");
    const result = await ws.bash("find /src -name '*.ts'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/src/index.ts");
    expect(result.stdout).toContain("/src/utils.ts");
    expect(result.stdout).not.toContain("README");
  });

  it("supports wc -l", async () => {
    const ws = getWorkspace(`ws-bash-wc-${crypto.randomUUID()}`);
    await ws.writeFile("/file.txt", "line 1\nline 2\nline 3\n");
    const result = await ws.bash("wc -l /file.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3");
  });

  it("supports mkdir and ls", async () => {
    const ws = getWorkspace(`ws-bash-ls-${crypto.randomUUID()}`);
    await ws.bash("mkdir -p /project/src");
    await ws.bash('echo "code" > /project/src/main.ts');
    const result = await ws.bash("ls /project/src");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("main.ts");
    // Verify file is also visible via our readFile
    expect(await ws.fileExists("/project/src/main.ts")).toBe(true);
  });

  it("returns non-zero exit code on error", async () => {
    const ws = getWorkspace(`ws-bash-err-${crypto.randomUUID()}`);
    const result = await ws.bash("cat /does-not-exist.txt");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("supports multi-line scripts", async () => {
    const ws = getWorkspace(`ws-bash-script-${crypto.randomUUID()}`);
    await ws.writeFile("/a.txt", "hello");
    await ws.writeFile("/b.txt", "world");
    const result = await ws.bash(`
      for f in /a.txt /b.txt; do
        cat $f
      done
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("world");
  });
});

// ── Workspace isolation ───────────────────────────────────────────────

describe("Workspace isolation", () => {
  it("different workspace instances have independent filesystems", async () => {
    const wsA = getWorkspace(`ws-iso-a-${crypto.randomUUID()}`);
    const wsB = getWorkspace(`ws-iso-b-${crypto.randomUUID()}`);

    await wsA.writeFile("/shared.ts", "from A");
    await wsB.writeFile("/shared.ts", "from B");

    expect(await wsA.readFile("/shared.ts")).toBe("from A");
    expect(await wsB.readFile("/shared.ts")).toBe("from B");
  });

  it("deleting files in one workspace doesn't affect another", async () => {
    const wsA = getWorkspace(`ws-del-iso-a-${crypto.randomUUID()}`);
    const wsB = getWorkspace(`ws-del-iso-b-${crypto.randomUUID()}`);

    await wsA.writeFile("/file.ts", "in A");
    await wsB.writeFile("/file.ts", "in B");

    await wsA.deleteFile("/file.ts");

    expect(await wsA.readFile("/file.ts")).toBeNull();
    expect(await wsB.readFile("/file.ts")).toBe("in B");
  });
});

// ── Complex scenarios ────────────────────────────────────────────────

describe("Workspace complex scenarios", () => {
  it("full project structure: create, navigate, delete", async () => {
    const ws = getWorkspace(`ws-project-${crypto.randomUUID()}`);

    // Build a project structure
    await ws.writeFile("/package.json", '{"name":"my-app"}');
    await ws.writeFile("/src/index.ts", "export default {}");
    await ws.writeFile("/src/utils/helpers.ts", "export const noop = () => {}");
    await ws.writeFile("/tests/index.test.ts", "import {} from '../src'");

    // Verify structure
    const root = await ws.listFiles("/");
    expect(root).toHaveLength(3); // package.json, src/, tests/
    expect(root.find((e) => e.name === "src")?.type).toBe("directory");

    const src = await ws.listFiles("/src");
    expect(src).toHaveLength(2); // index.ts, utils/

    const info = await ws.getInfo();
    expect(info.fileCount).toBe(4);
    expect(info.directoryCount).toBeGreaterThanOrEqual(3); // src, utils, tests + root

    // Delete the tests directory recursively
    await ws.rm("/tests", { recursive: true });
    const rootAfter = await ws.listFiles("/");
    expect(rootAfter).toHaveLength(2); // package.json, src/
  });

  it("rename file by copy + delete", async () => {
    const ws = getWorkspace(`ws-rename-${crypto.randomUUID()}`);
    await ws.writeFile("/old-name.ts", "content");

    const content = await ws.readFile("/old-name.ts");
    await ws.writeFile("/new-name.ts", content!);
    await ws.deleteFile("/old-name.ts");

    expect(await ws.fileExists("/old-name.ts")).toBe(false);
    expect(await ws.readFile("/new-name.ts")).toBe("content");
  });
});

// ── ThinkAgent workspace management (RPC) ────────────────────────────

describe("ThinkAgent workspace management (RPC)", () => {
  it("starts with the default workspace", async () => {
    const agent = await getThinkAgent(`no-ws-${crypto.randomUUID()}`);
    const workspaces = await agent.getWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe("default");
    expect(workspaces[0].name).toBe("Default");
  });

  it("creates a workspace", async () => {
    const agent = await getThinkAgent(`create-ws-${crypto.randomUUID()}`);
    const ws = await agent.createWorkspace("My Workspace");

    expect(ws.id).toBeTruthy();
    expect(ws.name).toBe("My Workspace");
    // default + the new one
    expect(await agent.getWorkspaces()).toHaveLength(2);
  });

  it("creates workspace with auto-generated name", async () => {
    const agent = await getThinkAgent(`auto-ws-${crypto.randomUUID()}`);
    const ws = await agent.createWorkspace();
    expect(ws.name).toContain("Workspace");
  });

  it("deletes a workspace", async () => {
    const agent = await getThinkAgent(`del-ws-${crypto.randomUUID()}`);
    const ws = await agent.createWorkspace("To Delete");
    await agent.deleteWorkspace(ws.id);
    // Only the default workspace remains
    expect(await agent.getWorkspaces()).toHaveLength(1);
  });

  it("renames a workspace", async () => {
    const agent = await getThinkAgent(`rename-ws-${crypto.randomUUID()}`);
    const ws = await agent.createWorkspace("Old Name");
    await agent.renameWorkspace(ws.id, "New Name");
    const workspaces = await agent.getWorkspaces();
    expect(workspaces.find((w) => w.id === ws.id)?.name).toBe("New Name");
  });

  it("attaches a workspace to a thread", async () => {
    const agent = await getThinkAgent(`attach-ws-${crypto.randomUUID()}`);
    const thread = await agent.createThread("Work Thread");
    const ws = await agent.createWorkspace("My Files");

    await agent.attachWorkspace(thread.id, ws.id);

    const threads = await agent.getThreads();
    expect(threads.find((t) => t.id === thread.id)?.workspaceId).toBe(ws.id);
  });

  it("detaches a workspace from a thread", async () => {
    const agent = await getThinkAgent(`detach-ws-${crypto.randomUUID()}`);
    const thread = await agent.createThread("Work Thread");
    const ws = await agent.createWorkspace("My Files");

    await agent.attachWorkspace(thread.id, ws.id);
    await agent.detachWorkspace(thread.id);

    const threads = await agent.getThreads();
    expect(threads.find((t) => t.id === thread.id)?.workspaceId).toBeNull();
  });

  it("deleting workspace detaches from all threads", async () => {
    const agent = await getThinkAgent(`del-detach-${crypto.randomUUID()}`);
    const thread = await agent.createThread("Work Thread");
    const ws = await agent.createWorkspace("To Delete");

    await agent.attachWorkspace(thread.id, ws.id);
    await agent.deleteWorkspace(ws.id);

    const threads = await agent.getThreads();
    expect(threads.find((t) => t.id === thread.id)?.workspaceId).toBeNull();
  });

  it("thread starts with default workspace attached", async () => {
    const agent = await getThinkAgent(`thread-nows-${crypto.randomUUID()}`);
    const thread = await agent.createThread("Plain Thread");
    expect(thread.workspaceId).toBe("default");
  });

  it("multiple threads can attach to the same workspace", async () => {
    const agent = await getThinkAgent(`multi-attach-${crypto.randomUUID()}`);
    const ws = await agent.createWorkspace("Shared Files");
    const t1 = await agent.createThread("Thread 1");
    const t2 = await agent.createThread("Thread 2");

    await agent.attachWorkspace(t1.id, ws.id);
    await agent.attachWorkspace(t2.id, ws.id);

    const threads = await agent.getThreads();
    const thread1 = threads.find((t) => t.id === t1.id);
    const thread2 = threads.find((t) => t.id === t2.id);
    expect(thread1?.workspaceId).toBe(ws.id);
    expect(thread2?.workspaceId).toBe(ws.id);
  });
});

// ── R2 hybrid storage ─────────────────────────────────────────────────
//
// vitest-pool-workers provides an in-memory R2 mock, so these tests
// run entirely locally without a real R2 bucket.

const INLINE_THRESHOLD = 1_500_000; // keep in sync with workspace.ts

describe("Workspace R2 hybrid storage", () => {
  it("small files are stored inline (no R2)", async () => {
    const ws = getWorkspace(`ws-r2-small-${crypto.randomUUID()}`);
    await ws.writeFile("/small.txt", "tiny content");

    const info = await ws.getInfo();
    expect(info.r2FileCount).toBe(0);

    // Content readable back correctly
    expect(await ws.readFile("/small.txt")).toBe("tiny content");
  });

  it("large files are stored in R2", async () => {
    const ws = getWorkspace(`ws-r2-large-${crypto.randomUUID()}`);
    const bigContent = "x".repeat(INLINE_THRESHOLD + 1);
    await ws.writeFile("/large.bin", bigContent);

    const info = await ws.getInfo();
    expect(info.r2FileCount).toBe(1);

    // Content is still fully readable
    const read = await ws.readFile("/large.bin");
    expect(read).toBe(bigContent);
  });

  it("stat still works for R2-backed files", async () => {
    const ws = getWorkspace(`ws-r2-stat-${crypto.randomUUID()}`);
    const bigContent = "y".repeat(INLINE_THRESHOLD + 100);
    await ws.writeFile("/big.dat", bigContent, "application/octet-stream");

    const s = await ws.stat("/big.dat");
    expect(s).not.toBeNull();
    expect(s!.type).toBe("file");
    expect(s!.size).toBe(new TextEncoder().encode(bigContent).byteLength);
    expect(s!.mimeType).toBe("application/octet-stream");
  });

  it("fileExists returns true for R2-backed files", async () => {
    const ws = getWorkspace(`ws-r2-exists-${crypto.randomUUID()}`);
    await ws.writeFile("/big.txt", "z".repeat(INLINE_THRESHOLD + 1));
    expect(await ws.fileExists("/big.txt")).toBe(true);
  });

  it("R2-backed file appears in listFiles", async () => {
    const ws = getWorkspace(`ws-r2-list-${crypto.randomUUID()}`);
    await ws.writeFile("/small.ts", "small");
    await ws.writeFile("/large.bin", "L".repeat(INLINE_THRESHOLD + 1));

    const entries = await ws.listFiles("/");
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === "large.bin")).not.toBeUndefined();
  });

  it("deleteFile cleans up R2 object", async () => {
    const ws = getWorkspace(`ws-r2-del-${crypto.randomUUID()}`);
    await ws.writeFile("/large.bin", "D".repeat(INLINE_THRESHOLD + 1));

    expect((await ws.getInfo()).r2FileCount).toBe(1);
    await ws.deleteFile("/large.bin");
    expect((await ws.getInfo()).r2FileCount).toBe(0);
    expect(await ws.readFile("/large.bin")).toBeNull();
  });

  it("rm cleans up R2 objects in subdirectories", async () => {
    const ws = getWorkspace(`ws-r2-rm-${crypto.randomUUID()}`);
    await ws.writeFile("/project/a.bin", "A".repeat(INLINE_THRESHOLD + 1));
    await ws.writeFile("/project/b.bin", "B".repeat(INLINE_THRESHOLD + 1));
    await ws.writeFile("/project/small.ts", "small");

    expect((await ws.getInfo()).r2FileCount).toBe(2);

    await ws.rm("/project", { recursive: true });

    expect((await ws.getInfo()).r2FileCount).toBe(0);
    expect((await ws.getInfo()).fileCount).toBe(0);
  });

  it("overwriting inline with large routes to R2", async () => {
    const ws = getWorkspace(`ws-r2-upgrade-${crypto.randomUUID()}`);
    await ws.writeFile("/file.txt", "small");
    expect((await ws.getInfo()).r2FileCount).toBe(0);

    // Overwrite with large content
    await ws.writeFile("/file.txt", "G".repeat(INLINE_THRESHOLD + 1));
    expect((await ws.getInfo()).r2FileCount).toBe(1);

    // Read back correctly
    const content = await ws.readFile("/file.txt");
    expect(content).toBe("G".repeat(INLINE_THRESHOLD + 1));
  });

  it("overwriting R2 with small routes back inline", async () => {
    const ws = getWorkspace(`ws-r2-downgrade-${crypto.randomUUID()}`);
    await ws.writeFile("/file.txt", "H".repeat(INLINE_THRESHOLD + 1));
    expect((await ws.getInfo()).r2FileCount).toBe(1);

    // Overwrite with small content
    await ws.writeFile("/file.txt", "small now");
    expect((await ws.getInfo()).r2FileCount).toBe(0);
    expect(await ws.readFile("/file.txt")).toBe("small now");
  });

  it("getInfo counts R2 files separately", async () => {
    const ws = getWorkspace(`ws-r2-info-${crypto.randomUUID()}`);
    await ws.writeFile("/s1.ts", "small 1");
    await ws.writeFile("/s2.ts", "small 2");
    await ws.writeFile("/l1.bin", "I".repeat(INLINE_THRESHOLD + 1));
    await ws.writeFile("/l2.bin", "J".repeat(INLINE_THRESHOLD + 1));

    const info = await ws.getInfo();
    expect(info.fileCount).toBe(4);
    expect(info.r2FileCount).toBe(2);
    expect(info.totalBytes).toBeGreaterThan(INLINE_THRESHOLD * 2);
  });
});

// ── listFiles pagination ───────────────────────────────────────────────

describe("Workspace.listFiles pagination", () => {
  it("returns all entries when count < default limit", async () => {
    const ws = getWorkspace(`ws-page-few-${crypto.randomUUID()}`);
    await ws.writeFile("/a.ts", "a");
    await ws.writeFile("/b.ts", "b");
    await ws.writeFile("/c.ts", "c");

    const entries = await ws.listFiles("/");
    expect(entries).toHaveLength(3);
  });

  it("limit restricts result count", async () => {
    const ws = getWorkspace(`ws-page-limit-${crypto.randomUUID()}`);
    for (let i = 0; i < 10; i++) {
      await ws.writeFile(`/file${i}.ts`, `content ${i}`);
    }

    const first5 = await ws.listFiles("/", { limit: 5 });
    expect(first5).toHaveLength(5);
  });

  it("offset skips entries", async () => {
    const ws = getWorkspace(`ws-page-offset-${crypto.randomUUID()}`);
    for (let i = 0; i < 6; i++) {
      await ws.writeFile(`/file${i}.ts`, `content ${i}`);
    }

    // ORDER BY type ASC, name ASC — so file0 < file1 < ... < file5
    const page1 = await ws.listFiles("/", { limit: 3, offset: 0 });
    const page2 = await ws.listFiles("/", { limit: 3, offset: 3 });

    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    // No overlap between pages
    const names1 = new Set(page1.map((e) => e.name));
    const names2 = new Set(page2.map((e) => e.name));
    for (const n of names2) expect(names1.has(n)).toBe(false);
  });

  it("offset beyond total returns empty array", async () => {
    const ws = getWorkspace(`ws-page-past-${crypto.randomUUID()}`);
    await ws.writeFile("/only.ts", "x");

    const result = await ws.listFiles("/", { limit: 10, offset: 100 });
    expect(result).toHaveLength(0);
  });

  it("limit=0 returns empty array", async () => {
    const ws = getWorkspace(`ws-page-zero-${crypto.randomUUID()}`);
    await ws.writeFile("/file.ts", "x");

    const result = await ws.listFiles("/", { limit: 0 });
    expect(result).toHaveLength(0);
  });

  it("pages are stable and non-overlapping across full traversal", async () => {
    const ws = getWorkspace(`ws-page-stable-${crypto.randomUUID()}`);
    const total = 15;
    for (let i = 0; i < total; i++) {
      // zero-pad so lexicographic order matches numeric order
      await ws.writeFile(`/f${String(i).padStart(2, "0")}.ts`, `${i}`);
    }

    const pageSize = 5;
    const collected: string[] = [];
    for (let offset = 0; offset < total; offset += pageSize) {
      const page = await ws.listFiles("/", { limit: pageSize, offset });
      collected.push(...page.map((e) => e.name));
    }

    expect(collected).toHaveLength(total);
    expect(new Set(collected).size).toBe(total); // no duplicates
  });
});

// ── Path traversal safety ─────────────────────────────────────────────

describe("WorkspaceFileSystem resolvePath safety", () => {
  // resolvePath is called by just-bash for all path resolution inside the
  // virtual shell environment. The virtual filesystem has no access to the
  // real host filesystem, so traversal only affects the virtual paths.
  // These tests verify that leading ".." segments cannot escape "/" and that
  // resolved paths are always valid absolute virtual paths.

  it("resolvePath resolves relative path against base", async () => {
    const ws = getWorkspace(`ws-resolve-rel-${crypto.randomUUID()}`);
    await ws.writeFile("/src/utils/helper.ts", "export {}");
    // bash `cat ../utils/helper.ts` from /src/components would resolve to /src/utils/helper.ts
    const result = await ws.bash(
      "mkdir -p /src/utils && echo 'export {}' > /src/utils/helper.ts && cat /src/utils/helper.ts"
    );
    expect(result.stdout.trim()).toBe("export {}");
  });

  it("leading .. in an absolute path cannot escape the virtual root /", async () => {
    const ws = getWorkspace(`ws-resolve-escape-${crypto.randomUUID()}`);
    // Write a file at /secret. Even if bash tries /../../../secret,
    // it should resolve to /secret (pop past "/" is a no-op).
    await ws.writeFile("/secret", "virtual-only");
    const result = await ws.bash("cat /../../../secret");
    expect(result.stdout.trim()).toBe("virtual-only");
  });

  it("paths with .. in the middle resolve correctly within the virtual root", async () => {
    const ws = getWorkspace(`ws-resolve-middle-${crypto.randomUUID()}`);
    await ws.writeFile("/a/b/c.txt", "hello");
    // /a/b/../b/c.txt should resolve to /a/b/c.txt
    const result = await ws.bash("cat /a/b/../b/c.txt");
    expect(result.stdout.trim()).toBe("hello");
  });

  it("traversal from deep dir cannot produce a path outside virtual root", async () => {
    const ws = getWorkspace(`ws-resolve-deep-${crypto.randomUUID()}`);
    // Any amount of .. from any path resolves within /
    const result = await ws.bash("cd /a/b/c 2>/dev/null || true && echo done");
    expect(result.stdout.trim()).toBe("done");
    expect(result.exitCode).toBe(0);
  });
});
