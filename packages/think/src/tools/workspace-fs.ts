import type { WorkspaceFsLike } from "@cloudflare/shell";
import type { WorkspaceLike } from "./workspace";

// The full filesystem surface required by createWorkspaceStateBackend. A custom
// Think WorkspaceLike may intentionally implement only the narrower direct-tool
// interface; in that case Code Mode omits workspace.* rather than casting it.
const WORKSPACE_FS_METHODS = [
  "readFile",
  "readFileBytes",
  "writeFile",
  "writeFileBytes",
  "appendFile",
  "exists",
  "stat",
  "lstat",
  "mkdir",
  "readDir",
  "rm",
  "cp",
  "mv",
  "symlink",
  "readlink",
  "glob"
] as const;

export function resolveWorkspaceFs(
  workspace: WorkspaceLike | undefined
): WorkspaceFsLike | undefined {
  if (!workspace) return undefined;
  const candidate = workspace as unknown as Record<string, unknown>;
  for (const method of WORKSPACE_FS_METHODS) {
    if (typeof candidate[method] !== "function") return undefined;
  }
  return workspace as unknown as WorkspaceFsLike;
}
