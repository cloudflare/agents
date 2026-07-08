export const WORKSPACE_PULL_IGNORE = [
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "temp"
] as const;

export function repoDirectory(repo: string | undefined): string {
  const name = repo?.split("/").filter(Boolean).at(-1) ?? "repo";
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  return `/workspace/${safe}`;
}
