/**
 * ToolProvider for git — exposes git.* commands in codemode sandboxes.
 *
 * Usage:
 *   import { gitTools } from "@cloudflare/shell/git";
 *
 *   createExecuteTool({
 *     tools: workspaceTools,
 *     providers: [gitTools(workspace)],
 *     loader: env.LOADER,
 *   });
 *
 * In the sandbox:
 *   await git.clone({ url: "https://github.com/org/repo", token: "ghp_..." });
 *   await git.add({ filepath: "." });
 *   await git.commit({ message: "fix: bug" });
 *   await git.push({ token: "ghp_..." });
 */

import type { ToolProvider } from "@cloudflare/codemode";
import type { FileSystem } from "../fs/interface";
import type { Workspace } from "../filesystem";
import { WorkspaceFileSystem } from "../workspace";
import { createGit, type Git } from "./index";

const GIT_TYPES = `
interface GitAuthor {
  name: string;
  email: string;
}

interface GitLogEntry {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  parent: string[];
}

interface GitStatusEntry {
  filepath: string;
  head: number;
  workdir: number;
  stage: number;
  status: string;
}

declare const git: {
  clone(opts: { url: string; dir?: string; depth?: number; branch?: string; singleBranch?: boolean }): Promise<{ cloned: string; dir: string }>;
  status(opts?: { dir?: string }): Promise<GitStatusEntry[]>;
  add(opts: { filepath: string; dir?: string }): Promise<{ added: string }>;
  rm(opts: { filepath: string; dir?: string }): Promise<{ removed: string }>;
  commit(opts: { message: string; author?: GitAuthor; dir?: string }): Promise<{ oid: string; message: string }>;
  log(opts?: { depth?: number; ref?: string; dir?: string }): Promise<GitLogEntry[]>;
  branch(opts?: { name?: string; list?: boolean; delete?: string; dir?: string }): Promise<{ branches?: string[]; current?: string | null; created?: string; deleted?: string }>;
  checkout(opts: { ref?: string; branch?: string; dir?: string; force?: boolean }): Promise<{ ref?: string; branch?: string; created?: boolean }>;
  fetch(opts?: { remote?: string; ref?: string; depth?: number; dir?: string }): Promise<{ fetchHead: string | null; fetchHeadDescription: string | null }>;
  pull(opts?: { remote?: string; ref?: string; dir?: string; author?: GitAuthor }): Promise<{ pulled: boolean }>;
  push(opts?: { remote?: string; ref?: string; force?: boolean; dir?: string }): Promise<{ ok: boolean; refs: Record<string, unknown> }>;
  diff(opts?: { dir?: string }): Promise<{ filepath: string; status: string }[]>;
  init(opts?: { dir?: string; defaultBranch?: string }): Promise<{ initialized: string }>;
  remote(opts: { list?: boolean; add?: { name: string; url: string }; remove?: string; dir?: string }): Promise<unknown>;
};
`;

const GIT_COMMAND_NAMES = [
  "clone",
  "status",
  "add",
  "rm",
  "commit",
  "log",
  "branch",
  "checkout",
  "fetch",
  "pull",
  "push",
  "diff",
  "init",
  "remote"
] as const;

/** Commands that accept a token/username/password for auth. */
const AUTH_COMMANDS = new Set(["clone", "fetch", "pull", "push"]);

function createGitToolProvider(gitInstance: Git, defaultToken?: string): ToolProvider {
  const tools: Record<
    string,
    { description: string; execute: (...args: unknown[]) => Promise<unknown> }
  > = {};

  for (const cmd of GIT_COMMAND_NAMES) {
    const fn = gitInstance[cmd] as (opts?: Record<string, unknown>) => Promise<unknown>;
    tools[cmd] = {
      description: `git.${cmd}`,
      execute: (...args: unknown[]) => {
        // positionalArgs mode: args may be [] (no args), [{}], or [{ url: ... }]
        let opts = (args[0] ?? {}) as Record<string, unknown>;
        // Auto-inject token for auth commands if not explicitly set
        if (defaultToken && AUTH_COMMANDS.has(cmd) && !opts.token && !opts.username) {
          opts = { ...opts, token: defaultToken };
        }
        return fn.call(gitInstance, opts);
      }
    };
  }

  return {
    name: "git",
    tools,
    types: GIT_TYPES,
    positionalArgs: true
  };
}

export interface GitToolsOptions {
  /** Default directory for git operations. */
  dir?: string;
  /** Default auth token — auto-injected into clone/fetch/pull/push. */
  token?: string;
}

/** Create a git ToolProvider from a Workspace. */
export function gitTools(workspace: Workspace, options?: GitToolsOptions): ToolProvider {
  const fs = new WorkspaceFileSystem(workspace);
  return createGitToolProvider(createGit(fs, options?.dir ?? "/"), options?.token);
}

/** Create a git ToolProvider from a raw FileSystem. */
export function gitToolsFromFs(filesystem: FileSystem, options?: GitToolsOptions): ToolProvider {
  return createGitToolProvider(createGit(filesystem, options?.dir ?? "/"), options?.token);
}
