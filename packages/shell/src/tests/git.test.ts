/**
 * Git tests — run in the Workers pool with a real DO-backed Workspace.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

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
    const newFile = status.find(
      (s: { filepath: string }) => s.filepath === "added.txt"
    );
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
      expect((entry as { stage: number }).stage).toBeGreaterThan(0);
    }
  });
});

describe("git diff", () => {
  it("shows added files", async () => {
    const agent = await freshAgent(`diff-add-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "original");
    await agent.add({ filepath: "." });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.writeFile("/new.txt", "added");

    const diff = await agent.diff();
    const entry = diff.find(
      (d: { filepath: string }) => d.filepath === "new.txt"
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("added");
  });

  it("shows modified files", async () => {
    const agent = await freshAgent(`diff-mod-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "original");
    await agent.add({ filepath: "." });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.writeFile("/file.txt", "changed");

    const diff = await agent.diff();
    const entry = diff.find(
      (d: { filepath: string }) => d.filepath === "file.txt"
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("modified");
  });

  it("shows deleted files", async () => {
    const agent = await freshAgent(`diff-del-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "original");
    await agent.add({ filepath: "." });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.deleteFile("/file.txt");

    const diff = await agent.diff();
    const entry = diff.find(
      (d: { filepath: string }) => d.filepath === "file.txt"
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("deleted");
  });
});

describe("git rm", () => {
  it("removes a tracked file from the index", async () => {
    const agent = await freshAgent(`rm-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "content");
    await agent.add({ filepath: "file.txt" });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    const result = await agent.rm({ filepath: "file.txt" });
    expect(result.removed).toBe("file.txt");

    const status = await agent.status();
    const entry = status.find(
      (s: { filepath: string }) => s.filepath === "file.txt"
    );
    expect(entry).toBeDefined();
  });
});

describe("git remote", () => {
  it("adds and lists remotes", async () => {
    const agent = await freshAgent(`remote-${Date.now()}`);
    await agent.init();

    const added = (await agent.remote({
      add: { name: "origin", url: "https://example.com/repo.git" }
    })) as { added: string };
    expect(added.added).toBe("origin");

    const list = await agent.remote({ list: true });
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          remote: "origin",
          url: "https://example.com/repo.git"
        })
      ])
    );
  });
});

describe("git status labels", () => {
  it("returns human-readable status strings", async () => {
    const agent = await freshAgent(`status-labels-${Date.now()}`);
    await agent.init();

    await agent.writeFile("/untracked.txt", "new");
    const status = await agent.status();
    const untracked = status.find(
      (s: { filepath: string }) => s.filepath === "untracked.txt"
    );
    expect(untracked).toBeDefined();
    expect(untracked!.status).toBe("new, untracked");
  });
});

describe("git commit default author", () => {
  it("uses fallback author when none provided", async () => {
    const agent = await freshAgent(`defauthor-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "content");
    await agent.add({ filepath: "file.txt" });

    const result = await agent.commit({ message: "auto author" });
    expect(result.oid).toBeDefined();

    const log = await agent.log({ depth: 1 });
    expect(log[0].author.name).toBe("Think Agent");
    expect(log[0].author.email).toBe("think@cloudflare.dev");
  });
});

describe("git add all with deletes", () => {
  it("stages deletions when using filepath '.'", async () => {
    const agent = await freshAgent(`addall-del-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/keep.txt", "keep");
    await agent.writeFile("/remove.txt", "remove");
    await agent.add({ filepath: "." });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.deleteFile("/remove.txt");
    await agent.add({ filepath: "." });

    const status = await agent.status();
    const removed = status.find(
      (s: { filepath: string }) => s.filepath === "remove.txt"
    );
    expect(removed).toBeDefined();
    expect(removed!.status).toContain("deleted");
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
