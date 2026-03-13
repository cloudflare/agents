/**
 * Format a numeric file mode as a symbolic permission string (e.g. "drwxr-xr-x").
 */
export function formatMode(mode: number, isDirectory: boolean): string {
  const typeChar = isDirectory ? "d" : "-";
  const perms = [
    mode & 0o400 ? "r" : "-",
    mode & 0o200 ? "w" : "-",
    mode & 0o100 ? "x" : "-",
    mode & 0o040 ? "r" : "-",
    mode & 0o020 ? "w" : "-",
    mode & 0o010 ? "x" : "-",
    mode & 0o004 ? "r" : "-",
    mode & 0o002 ? "w" : "-",
    mode & 0o001 ? "x" : "-"
  ];
  return typeChar + perms.join("");
}
