/**
 * Git tests — run in the Workers pool with a real DO-backed Workspace.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { createGitToolProvider, type GitAuthOptions } from "../git/provider";
import type { Git } from "../git";

async function freshAgent(name: string) {
  return getAgentByName(env.TestGitAgent, name);
}

type GitCallOptions = Record<string, unknown>;
type GitCalls = Record<string, GitCallOptions | undefined>;

type ProviderTool = {
  description?: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

function getProviderTool(tools: unknown, command: string): ProviderTool {
  const tool = (tools as Record<string, ProviderTool | undefined>)[command];
  if (!tool) {
    throw new Error(`Missing provider tool: ${command}`);
  }
  return tool;
}

function createFakeGit() {
  const calls: GitCalls = {};
  const git = {
    clone: async (opts?: GitCallOptions) => {
      calls.clone = opts;
      return { cloned: "https://example.com/repo.git", dir: "/" };
    },
    status: async (opts?: GitCallOptions) => {
      calls.status = opts;
      return [];
    },
    add: async (opts?: GitCallOptions) => {
      calls.add = opts;
      return { added: opts?.filepath };
    },
    rm: async (opts?: GitCallOptions) => {
      calls.rm = opts;
      return { removed: opts?.filepath };
    },
    commit: async (opts?: GitCallOptions) => {
      calls.commit = opts;
      return { oid: "oid", message: opts?.message };
    },
    log: async (opts?: GitCallOptions) => {
      calls.log = opts;
      return [];
    },
    branch: async (opts?: GitCallOptions) => {
      calls.branch = opts;
      return {};
    },
    checkout: async (opts?: GitCallOptions) => {
      calls.checkout = opts;
      return {};
    },
    fetch: async (opts?: GitCallOptions) => {
      calls.fetch = opts;
      return { fetchHead: null, fetchHeadDescription: null };
    },
    pull: async (opts?: GitCallOptions) => {
      calls.pull = opts;
      return { pulled: true };
    },
    push: async (opts?: GitCallOptions) => {
      calls.push = opts;
      return { ok: true, refs: {} };
    },
    diff: async (opts?: GitCallOptions) => {
      calls.diff = opts;
      return [];
    },
    init: async (opts?: GitCallOptions) => {
      calls.init = opts;
      return { initialized: "/" };
    },
    remote: async (opts?: GitCallOptions) => {
      calls.remote = opts;
      return [];
    }
  };

  return { git: git as unknown as Git, calls };
}

describe("git ToolProvider auth injection", () => {
  it.each(["clone", "fetch", "pull", "push"] as const)(
    "injects default basic auth into git.%s",
    async (command) => {
      const { git, calls } = createFakeGit();
      const auth: GitAuthOptions = {
        username: "default-user",
        password: "default-password"
      };
      const provider = createGitToolProvider(git, { auth });

      await getProviderTool(provider.tools, command).execute({});

      expect(calls[command]).toMatchObject(auth);
    }
  );

  it("keeps default token injection for backward compatibility", async () => {
    const { git, calls } = createFakeGit();
    const provider = createGitToolProvider(git, { token: "default-token" });

    await getProviderTool(provider.tools, "push").execute({});

    expect(calls.push).toMatchObject({ token: "default-token" });
  });

  it("prefers default basic auth over the default token", async () => {
    const { git, calls } = createFakeGit();
    const provider = createGitToolProvider(git, {
      token: "default-token",
      auth: {
        username: "default-user",
        password: "default-password"
      }
    });

    await getProviderTool(provider.tools, "push").execute({});

    expect(calls.push).toMatchObject({
      username: "default-user",
      password: "default-password"
    });
    expect(calls.push).not.toHaveProperty("token");
  });

  it("prefers explicit token auth over default basic auth", async () => {
    const { git, calls } = createFakeGit();
    const provider = createGitToolProvider(git, {
      auth: {
        username: "default-user",
        password: "default-password"
      }
    });

    await getProviderTool(provider.tools, "push").execute({
      token: "explicit-token"
    });

    expect(calls.push).toEqual({ token: "explicit-token" });
  });

  it("prefers explicit username and password over default basic auth", async () => {
    const { git, calls } = createFakeGit();
    const provider = createGitToolProvider(git, {
      auth: {
        username: "default-user",
        password: "default-password"
      }
    });

    await getProviderTool(provider.tools, "push").execute({
      username: "explicit-user",
      password: "explicit-password"
    });

    expect(calls.push).toEqual({
      username: "explicit-user",
      password: "explicit-password"
    });
  });

  it("treats any explicit auth field as an override", async () => {
    const { git, calls } = createFakeGit();
    const provider = createGitToolProvider(git, {
      auth: {
        username: "default-user",
        password: "default-password"
      }
    });

    await getProviderTool(provider.tools, "push").execute({
      password: "explicit-password"
    });

    expect(calls.push).toEqual({ password: "explicit-password" });
  });

  it("does not inject auth into non-auth commands", async () => {
    const { git, calls } = createFakeGit();
    const provider = createGitToolProvider(git, {
      auth: {
        username: "default-user",
        password: "default-password"
      },
      token: "default-token"
    });

    await getProviderTool(provider.tools, "status").execute({});

    expect(calls.status).toEqual({});
  });

  it("keeps hidden auth out of provider descriptions and types", () => {
    const { git } = createFakeGit();
    const provider = createGitToolProvider(git, {
      token: "hidden-token",
      auth: {
        username: "hidden-user",
        password: "hidden-password"
      }
    });
    const visibleSurface = [
      provider.name,
      provider.types,
      ...Object.values(provider.tools as Record<string, ProviderTool>).map(
        (tool) => tool.description
      )
    ].join("\n");

    expect(visibleSurface).not.toContain("hidden-token");
    expect(visibleSurface).not.toContain("hidden-user");
    expect(visibleSurface).not.toContain("hidden-password");
  });

  it("does not echo hidden auth in provider results", async () => {
    const { git } = createFakeGit();
    const provider = createGitToolProvider(git, {
      auth: {
        username: "hidden-user",
        password: "hidden-password"
      }
    });

    const result = await getProviderTool(provider.tools, "push").execute({});
    const serializedResult = JSON.stringify(result);

    expect(serializedResult).not.toContain("hidden-user");
    expect(serializedResult).not.toContain("hidden-password");
  });
});

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

  it("reports modified, unstaged for workdir-only changes", async () => {
    const agent = await freshAgent(`status-mod-unstaged-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "original");
    await agent.add({ filepath: "file.txt" });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.writeFile("/file.txt", "changed");
    const status = await agent.status();
    const entry = status.find(
      (s: { filepath: string }) => s.filepath === "file.txt"
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("modified, unstaged");
  });

  it("reports deleted, unstaged for workdir-only deletions", async () => {
    const agent = await freshAgent(`status-del-unstaged-${Date.now()}`);
    await agent.init();
    await agent.writeFile("/file.txt", "content");
    await agent.add({ filepath: "file.txt" });
    await agent.commit({
      message: "init",
      author: { name: "T", email: "t@t.com" }
    });

    await agent.deleteFile("/file.txt");
    const status = await agent.status();
    const entry = status.find(
      (s: { filepath: string }) => s.filepath === "file.txt"
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("deleted, unstaged");
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
