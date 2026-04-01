// ── Git output parsers ──────────────────────────────────────────────
//
// Parse the structured output of git commands into typed objects.

export interface GitStatusEntry {
  filepath: string;
  status: string;
}

export function parseGitStatusPorcelainV2(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Tracked entries: "1 XY sub mH mI mW hH hI path"
      // or renamed:       "2 XY sub mH mI mW hH hI X## path\torigPath"
      const xy = line.substring(2, 4);
      const parts = line.split("\t");
      const pathPart = parts[0].split(" ").pop() ?? "";
      const filepath =
        parts.length > 1 ? (parts[0].split(" ").pop() ?? "") : pathPart;
      entries.push({ filepath, status: xy });
    } else if (line.startsWith("? ")) {
      entries.push({ filepath: line.substring(2), status: "untracked" });
    } else if (line.startsWith("! ")) {
      entries.push({ filepath: line.substring(2), status: "ignored" });
    }
  }
  return entries;
}

export interface GitLogEntry {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export function parseGitLog(stdout: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\x1f");
    if (parts.length >= 5) {
      entries.push({
        oid: parts[0],
        message: parts[1],
        authorName: parts[2],
        authorEmail: parts[3],
        timestamp: parseInt(parts[4], 10)
      });
    }
  }
  return entries;
}

export interface GitDiffEntry {
  status: string;
  filepath: string;
}

export function parseGitDiff(stdout: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [status, ...rest] = line.split("\t");
    if (status && rest.length > 0) {
      entries.push({ status, filepath: rest.join("\t") });
    }
  }
  return entries;
}
