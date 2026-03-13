/**
 * Utility functions for curl command
 */

/**
 * Format response headers for output
 */
export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
}

/**
 * Extract filename from URL for -O option
 */
export function extractFilename(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop();
    return filename || "index.html";
  } catch {
    return "index.html";
  }
}

/**
 * Apply write-out format string replacements
 */
export function applyWriteOut(
  format: string,
  result: {
    status: number;
    headers: Record<string, string>;
    url: string;
    bodyLength: number;
  }
): string {
  let output = format;
  output = output.replace(/%\{http_code\}/g, String(result.status));
  output = output.replace(
    /%\{content_type\}/g,
    result.headers["content-type"] || ""
  );
  output = output.replace(/%\{url_effective\}/g, result.url);
  output = output.replace(/%\{size_download\}/g, String(result.bodyLength));
  output = output.replace(/\\n/g, "\n");
  return output;
}
