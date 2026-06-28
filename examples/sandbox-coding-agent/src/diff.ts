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

/**
 * Snapshot a container's working tree as a unified diff. `-N` marks untracked
 * files as intent-to-add so brand-new files also show up in `git diff`.
 */
export async function snapshotDiff(
  sandbox: Sandbox,
  workDir: string
): Promise<WorkspaceDiff> {
  await sandbox.exec("git add -A -N", { cwd: workDir });
  const [status, diff] = await Promise.all([
    sandbox.exec("git status --porcelain", { cwd: workDir }),
    sandbox.exec("git diff", { cwd: workDir })
  ]);
  return { files: parseStatus(status.stdout), diff: diff.stdout };
}
