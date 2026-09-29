import type { Sandbox } from "@cloudflare/sandbox";

export type WorkspaceFile = { status: string; path: string };
export type WorkspaceDiff = { files: WorkspaceFile[]; diff: string };

export function parseStatus(porcelain: string): WorkspaceFile[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3)
    }));
}

/** Run a git command in the checkout; throw (with stderr) if it fails. */
async function git(
  sandbox: Sandbox,
  workDir: string,
  command: string
): Promise<string> {
  const result = await sandbox.exec(command, { cwd: workDir });
  if (!result.success) {
    throw new Error(
      `\`${command}\` exited with code ${result.exitCode}: ` +
        (result.stderr.trim() || "no stderr")
    );
  }
  return result.stdout;
}

/**
 * Snapshot a container's working tree as a unified diff. `-N` marks untracked
 * files as intent-to-add so brand-new files also show up in `git diff`.
 */
export async function snapshotDiff(
  sandbox: Sandbox,
  workDir: string
): Promise<WorkspaceDiff> {
  await git(sandbox, workDir, "git add -A -N");
  const [status, diff] = await Promise.all([
    git(sandbox, workDir, "git status --porcelain"),
    git(sandbox, workDir, "git diff")
  ]);
  return { files: parseStatus(status), diff };
}
