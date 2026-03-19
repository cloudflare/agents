/**
 * Git commands for the shell — wraps isomorphic-git with a CLI-style interface.
 *
 * Each function matches the `git <command>` CLI argument names.
 * Operations run entirely in the virtual filesystem (SQLite/R2).
 *
 * Usage in codemode sandbox:
 *   await git.clone({ url: "https://github.com/org/repo" })
 *   await git.status()
 *   await git.add({ filepath: "." })
 *   await git.commit({ message: "feat: something", author: { name: "Matt", email: "m@x.com" } })
 *   await git.push({ remote: "origin" })
 *   await git.log({ depth: 10 })
 */

import type { FileSystem } from "../fs/interface";
import { createGitFs } from "./fs-adapter";

// Lazy-load isomorphic-git to avoid bundling it when not used
let _git: typeof import("isomorphic-git") | null = null;
let _http: typeof import("isomorphic-git/http/web") | null = null;

async function getGit() {
  if (!_git) _git = await import("isomorphic-git");
  return _git;
}

async function getHttp() {
  if (!_http) _http = await import("isomorphic-git/http/web");
  return _http;
}

/** Author/committer identity. */
export interface GitAuthor {
  name: string;
  email: string;
}

/** Result from git.log */
export interface GitLogEntry {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parent: string[];
}

/** Result from git.status */
export interface GitStatusEntry {
  filepath: string;
  /** HEAD status: 0=absent, 1=present */
  head: number;
  /** Workdir status: 0=absent, 1=identical, 2=modified */
  workdir: number;
  /** Stage status: 0=absent, 1=identical, 2=modified, 3=added */
  stage: number;
  /** Human-readable status */
  status: string;
}

/**
 * Create a git command set bound to a FileSystem.
 * All paths are relative to `dir` (default: "/").
 */
export function createGit(filesystem: FileSystem, defaultDir = "/") {
  const fs = createGitFs(filesystem);
  const dir = defaultDir;

  function resolveDir(d?: string) {
    return d ?? dir;
  }

  return {
    /** git clone <url> [--depth N] [--branch <ref>] [--single-branch] */
    async clone(opts: {
      url: string;
      dir?: string;
      depth?: number;
      branch?: string;
      singleBranch?: boolean;
      noCheckout?: boolean;
      token?: string;
      username?: string;
      password?: string;
    }) {
      const git = await getGit();
      const http = await getHttp();
      const headers: Record<string, string> = {};
      const onAuth = opts.token
        ? () => ({ username: opts.token!, password: "x-oauth-basic" })
        : opts.username
          ? () => ({ username: opts.username!, password: opts.password ?? "" })
          : undefined;

      await git.clone({
        fs,
        http,
        dir: resolveDir(opts.dir),
        url: opts.url,
        depth: opts.depth,
        ref: opts.branch,
        singleBranch: opts.singleBranch ?? true,
        noCheckout: opts.noCheckout,
        onAuth,
        headers
      });

      return { cloned: opts.url, dir: resolveDir(opts.dir) };
    },

    /** git status [--short] */
    async status(opts?: { dir?: string }) {
      const git = await getGit();
      const matrix = await git.statusMatrix({ fs, dir: resolveDir(opts?.dir) });

      const statusMap: Record<string, string> = {
        "003": "added, staged",
        "020": "new, untracked",
        "022": "added, staged",
        "023": "added, staged, with unstaged changes",
        "100": "deleted, unstaged",
        "101": "deleted, staged",
        "103": "deleted from HEAD, added to stage",
        "110": "deleted, unstaged",
        "111": "unmodified",
        "120": "modified, unstaged",
        "121": "modified, staged",
        "122": "modified, staged",
        "123": "modified, staged, with unstaged changes"
      };

      const entries: GitStatusEntry[] = matrix.map(
        ([filepath, head, workdir, stage]) => ({
          filepath: filepath as string,
          head: head as number,
          workdir: workdir as number,
          stage: stage as number,
          status: statusMap[`${head}${workdir}${stage}`] ?? "unknown"
        })
      );

      // Filter out unmodified files
      return entries.filter((e) => e.status !== "unmodified");
    },

    /** git add <filepath> (use "." for all) */
    async add(opts: { filepath: string; dir?: string }) {
      const git = await getGit();
      const d = resolveDir(opts.dir);

      if (opts.filepath === ".") {
        // Stage all changes
        const matrix = await git.statusMatrix({ fs, dir: d });
        for (const [filepath, head, workdir, stage] of matrix) {
          const key = `${head}${workdir}${stage}`;
          if (key === "111") continue; // unmodified

          if (workdir === 0) {
            // Deleted
            await git.remove({ fs, dir: d, filepath: filepath as string });
          } else {
            await git.add({ fs, dir: d, filepath: filepath as string });
          }
        }
        return { added: "." };
      }

      await git.add({ fs, dir: d, filepath: opts.filepath });
      return { added: opts.filepath };
    },

    /** git rm <filepath> */
    async rm(opts: { filepath: string; dir?: string }) {
      const git = await getGit();
      await git.remove({ fs, dir: resolveDir(opts.dir), filepath: opts.filepath });
      return { removed: opts.filepath };
    },

    /** git commit -m <message> --author "<name> <email>" */
    async commit(opts: {
      message: string;
      author?: GitAuthor;
      dir?: string;
    }) {
      const git = await getGit();
      const author = opts.author ?? { name: "Think Agent", email: "think@cloudflare.dev" };
      const oid = await git.commit({
        fs,
        dir: resolveDir(opts.dir),
        message: opts.message,
        author
      });
      return { oid, message: opts.message };
    },

    /** git log [--depth N] [--ref <ref>] */
    async log(opts?: { depth?: number; ref?: string; dir?: string }) {
      const git = await getGit();
      const commits = await git.log({
        fs,
        dir: resolveDir(opts?.dir),
        depth: opts?.depth ?? 20,
        ref: opts?.ref ?? "HEAD"
      });

      return commits.map((c): GitLogEntry => ({
        oid: c.oid,
        message: c.commit.message,
        author: {
          name: c.commit.author.name,
          email: c.commit.author.email,
          timestamp: c.commit.author.timestamp
        },
        parent: c.commit.parent
      }));
    },

    /** git branch [--list] or git branch <name> */
    async branch(opts?: { name?: string; list?: boolean; delete?: string; dir?: string }) {
      const git = await getGit();
      const d = resolveDir(opts?.dir);

      if (opts?.delete) {
        await git.deleteBranch({ fs, dir: d, ref: opts.delete });
        return { deleted: opts.delete };
      }

      if (opts?.name) {
        await git.branch({ fs, dir: d, ref: opts.name });
        return { created: opts.name };
      }

      // List branches
      const branches = await git.listBranches({ fs, dir: d });
      const current = await git.currentBranch({ fs, dir: d });
      return { branches, current };
    },

    /** git checkout <ref> or git checkout -b <branch> */
    async checkout(opts: {
      ref?: string;
      branch?: string;
      dir?: string;
      force?: boolean;
    }) {
      const git = await getGit();
      const d = resolveDir(opts.dir);

      if (opts.branch) {
        // checkout -b: create branch and switch
        await git.branch({ fs, dir: d, ref: opts.branch });
        await git.checkout({ fs, dir: d, ref: opts.branch, force: opts.force });
        return { branch: opts.branch, created: true };
      }

      await git.checkout({ fs, dir: d, ref: opts.ref!, force: opts.force });
      return { ref: opts.ref };
    },

    /** git fetch [--remote <name>] [--ref <ref>] */
    async fetch(opts?: {
      remote?: string;
      ref?: string;
      depth?: number;
      dir?: string;
      token?: string;
      username?: string;
      password?: string;
    }) {
      const git = await getGit();
      const http = await getHttp();
      const onAuth = opts?.token
        ? () => ({ username: opts.token!, password: "x-oauth-basic" })
        : opts?.username
          ? () => ({ username: opts.username!, password: opts.password ?? "" })
          : undefined;

      const result = await git.fetch({
        fs,
        http,
        dir: resolveDir(opts?.dir),
        remote: opts?.remote ?? "origin",
        ref: opts?.ref,
        depth: opts?.depth,
        onAuth
      });

      return {
        fetchHead: result.fetchHead,
        fetchHeadDescription: result.fetchHeadDescription
      };
    },

    /** git pull [--remote <name>] [--ref <ref>] */
    async pull(opts?: {
      remote?: string;
      ref?: string;
      dir?: string;
      author?: GitAuthor;
      token?: string;
      username?: string;
      password?: string;
    }) {
      const git = await getGit();
      const http = await getHttp();
      const author = opts?.author ?? { name: "Think Agent", email: "think@cloudflare.dev" };
      const onAuth = opts?.token
        ? () => ({ username: opts.token!, password: "x-oauth-basic" })
        : opts?.username
          ? () => ({ username: opts.username!, password: opts.password ?? "" })
          : undefined;

      await git.pull({
        fs,
        http,
        dir: resolveDir(opts?.dir),
        remote: opts?.remote ?? "origin",
        ref: opts?.ref,
        author,
        onAuth
      });

      return { pulled: true };
    },

    /** git push [--remote <name>] [--ref <ref>] [--force] */
    async push(opts?: {
      remote?: string;
      ref?: string;
      force?: boolean;
      dir?: string;
      token?: string;
      username?: string;
      password?: string;
    }) {
      const git = await getGit();
      const http = await getHttp();
      const onAuth = opts?.token
        ? () => ({ username: opts.token!, password: "x-oauth-basic" })
        : opts?.username
          ? () => ({ username: opts.username!, password: opts.password ?? "" })
          : undefined;

      const result = await git.push({
        fs,
        http,
        dir: resolveDir(opts?.dir),
        remote: opts?.remote ?? "origin",
        ref: opts?.ref,
        force: opts?.force,
        onAuth
      });

      return { ok: result.ok, refs: result.refs };
    },

    /** git diff [--cached] — show changed files */
    async diff(opts?: { dir?: string }) {
      const git = await getGit();
      const d = resolveDir(opts?.dir);
      const matrix = await git.statusMatrix({ fs, dir: d });

      const changes: { filepath: string; status: string }[] = [];
      for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 1 && workdir === 1 && stage === 1) continue; // unmodified
        let status = "modified";
        if (head === 0) status = "added";
        if (workdir === 0) status = "deleted";
        changes.push({ filepath: filepath as string, status });
      }
      return changes;
    },

    /** git init */
    async init(opts?: { dir?: string; defaultBranch?: string }) {
      const git = await getGit();
      await git.init({
        fs,
        dir: resolveDir(opts?.dir),
        defaultBranch: opts?.defaultBranch ?? "main"
      });
      return { initialized: resolveDir(opts?.dir) };
    },

    /** git remote — list, add, or remove remotes */
    async remote(opts: {
      list?: boolean;
      add?: { name: string; url: string };
      remove?: string;
      dir?: string;
    }) {
      const git = await getGit();
      const d = resolveDir(opts.dir);

      if (opts.add) {
        await git.addRemote({ fs, dir: d, remote: opts.add.name, url: opts.add.url });
        return { added: opts.add.name, url: opts.add.url };
      }

      if (opts.remove) {
        await git.deleteRemote({ fs, dir: d, remote: opts.remove });
        return { removed: opts.remove };
      }

      // List
      const remotes = await git.listRemotes({ fs, dir: d });
      return remotes;
    }
  };
}

export type Git = ReturnType<typeof createGit>;

// ── ToolProvider for codemode sandboxes ──────────────────────────────
export { gitTools, gitToolsFromFs } from "./provider";
