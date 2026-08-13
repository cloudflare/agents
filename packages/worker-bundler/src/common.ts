/*
 * File for imports common between multiple files, to avoid cyclic imports.
 */

export const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

export interface InstallResult {
  /**
   * Packages that were freshly installed in this call.
   * Packages already present in the filesystem are skipped and not listed here.
   */
  installed: string[];

  /**
   * Warnings encountered during installation
   */
  warnings: string[];
}

/**
 * Check if a file path is likely a text file.
 */
export function isTextFile(path: string): boolean {
  const textExtensions = [
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".css",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".xml",
    ".svg",
    ".map",
    ".d.ts",
    ".d.mts",
    ".d.cts",
    ".py"
  ];

  // Check common config files without extensions
  const configFiles = [
    "LICENSE",
    "README",
    "CHANGELOG",
    "package.json",
    "tsconfig.json",
    ".npmignore",
    ".gitignore"
  ];

  const fileName = path.split("/").pop() ?? "";

  if (
    configFiles.some((f) => fileName.toUpperCase().startsWith(f.toUpperCase()))
  ) {
    return true;
  }

  return textExtensions.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * Fetch with a timeout.
 * Throws an error if the request takes longer than the specified timeout.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms (npm registry slow or unreachable from this Worker)`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
