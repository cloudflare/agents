/**
 * Git tests — run in the Workers pool with a real DO-backed Workspace.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "agents";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function freshAgent(name: string) {
  return getAgentByName(env.TestGitAgent, name);
}

describe("git init", () => {
  it("initializes a repo in the workspace", async () => {
    const agent = await freshAgent(`init-${Date.now()}`);
    const result = await agent.init({ defaultBranch: "main" });
    expect(result.initialized).toBe("/");

    const branches = await agent.branch();
    expect(branches.current).toBe("main");
  });
});

describe("git add + commit + log", () => {
  it("commits a file and shows it in log", async () => {
    const agent = await freshAgent(`commit-${Date.now()}`);
    await agent.init();

    await agent.writeFile("/hello.txt", "hello world");
    await agent.add({ filepath: "hello.txt" });
    const commit = await agent.commit({
      message: "initial commit",
      author: { name: "Test", email: "test@test.com" }
    });

    expect(commit.oid).toBeDefined();

    const log = await agent.log({ depth: 1 });
    expect(log).toHaveLength(1);
    expect(log[0].message.trim()).toBe("initial commit");
    expect(log[0].oid).toBe(commit.oid);
  });
});

describe("git status", () => {
  it("shows untracked files", async () => {
    const agent = await freshAgent(`status-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/new.txt", "new file");

    const status = await agent.status();
    expect(status.length).toBeGreaterThan(0);
    expect(status[0].filepath).toBe("new.txt");
  });

  it("shows new files after commit", async () => {
    const agent = await freshAgent(`status-new-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "original");
    await agent.add({ filepath: "file.txt" });
    await agent.commit({
      message: "first",
      author: { name: "Test", email: "t@t.com" }
    });

    await agent.writeFile("/added.txt", "new content");
    const status = await agent.status();
    const newFile = status.find((s: any) => s.filepath === "added.txt");
    expect(newFile).toBeDefined();
  });
});

describe("git branch + checkout", () => {
  it("creates and switches branches", async () => {
    const agent = await freshAgent(`branch-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "content");
    await agent.add({ filepath: "file.txt" });
    await agent.commit({
      message: "init",
      author: { name: "Test", email: "t@t.com" }
    });

    await agent.checkout({ branch: "feature" });
    const branches = await agent.branch();
    expect(branches.branches).toContain("feature");
    expect(branches.current).toBe("feature");

    await agent.checkout({ ref: "main" });
    const after = await agent.branch();
    expect(after.current).toBe("main");
  });
});

describe("git add all", () => {
  it("stages all changes with filepath '.'", async () => {
    const agent = await freshAgent(`addall-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/a.txt", "a");
    await agent.writeFile("/b.txt", "b");

    await agent.add({ filepath: "." });

    const status = await agent.status();
    for (const entry of status) {
      expect((entry as any).stage).toBeGreaterThan(0);
    }
  });
});

describe("git diff", () => {
  it("shows changed files", async () => {
    const agent = await freshAgent(`diff-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "original");
    await agent.add({ filepath: "." });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.writeFile("/new.txt", "added");

    const diff = await agent.diff();
    const paths = diff.map((d: any) => d.filepath);
    expect(paths).toContain("new.txt");
  });
});

describe("git clone", () => {
  // Clone requires outbound network — skip in Workers test pool.
  // Test manually via `wrangler dev` or deploy.
  it.skip("clones a small public repo (requires network)", async () => {
    const agent = await freshAgent(`clone-${Date.now()}`);
    const result = await agent.clone({
      url: "https://github.com/nicolo-ribaudo/tc39-proposal-await-dictionary.git",
      depth: 1
    });
    expect(result.cloned).toBeDefined();

    const content = await agent.readFile("/README.md");
    expect(content).toBeTruthy();

    const log = await agent.log({ depth: 1 });
    expect(log).toHaveLength(1);
  }, 30000);
});
