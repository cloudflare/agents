// Shared CLI helpers used by both `npm create think` (this package) and
// `think init` (the `@cloudflare/think` CLI, which imports from here). Keeping
// them in one place means the git/npm spawning, the existing-repo guard, and
// the small fs helpers cannot drift between the two entry points.

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";

export type GitInitOutcome = "initialized" | "existing" | "failed";

export interface InitializeGitOptions {
  /** Injectable for tests; defaults to spawning `git init`. */
  gitRunner?: (root: string) => Promise<void>;
  /** Injectable for tests; defaults to `git rev-parse --is-inside-work-tree`. */
  isInsideGitRepo?: (root: string) => Promise<boolean>;
}

/**
 * Initialize a git repository, but never on top of an existing one. Skipping
 * when already inside a work tree avoids the misleading "Reinitialized existing
 * Git repository" reinit and, more importantly, avoids creating a nested repo
 * when scaffolding into a subfolder of an existing project. A missing or broken
 * git binary is non-fatal: we warn and continue.
 */
export async function initializeGit(
  root: string,
  options: InitializeGitOptions = {}
): Promise<GitInitOutcome> {
  const insideRepo = options.isInsideGitRepo ?? isInsideGitRepo;
  if (await insideRepo(root)) return "existing";
  try {
    await (options.gitRunner ?? runGitInit)(root);
    return "initialized";
  } catch (error) {
    console.warn(
      `Could not initialize a git repository: ${errorMessage(error)}`
    );
    return "failed";
  }
}

/** Human-readable line describing what `initializeGit` did. */
export function gitOutcomeMessage(outcome: GitInitOutcome): string {
  switch (outcome) {
    case "initialized":
      return "Initialized a git repository.";
    case "existing":
      return "Already inside a git repository — skipped git init.";
    case "failed":
      return "Skipped git init.";
  }
}

export function isInsideGitRepo(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: "ignore",
      // On Windows `git` may resolve through a shell shim.
      shell: process.platform === "win32"
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export async function runGitInit(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init"], {
      cwd: root,
      stdio: "ignore",
      // On Windows `git` may resolve through a shell shim.
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git init failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

export async function runNpmInstall(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd: root,
      stdio: "inherit",
      // On Windows `npm` resolves to `npm.cmd`, which Node's spawn won't find
      // without a shell.
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`npm install failed with exit code ${code ?? "unknown"}.`)
      );
    });
  });
}

export function packageName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[._]+/, "") || "think-agent"
  );
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
