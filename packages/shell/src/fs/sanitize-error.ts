/**
 * Error message sanitization utility.
 *
 * This module has NO Node.js dependencies (no `node:fs`, etc.) so it can
 * safely be imported in browser bundles.
 */

/**
 * Sanitize an error message to strip real OS filesystem paths and stack traces.
 *
 * - Replaces common OS path prefixes (/Users/, /home/, /private/, C:\, etc.)
 *   with `<path>` to prevent information leakage about the host filesystem.
 * - Strips stack trace lines (`\n    at ...`).
 * - Preserves error codes (ENOENT, EACCES, etc.) and virtual paths that don't
 *   match known OS prefixes.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return message;

  // Strip stack trace lines (lines starting with whitespace + "at ")
  let sanitized = message.replace(/\n\s+at\s.*/g, "");

  // Replace real OS paths with <path>
  // Match absolute Unix-style paths that start with common OS prefixes
  sanitized = sanitized.replace(
    /(?:\/(?:Users|home|private|var|opt|Library|System|usr|etc|tmp|nix|snap))\b[^\s'",)}\]:]*/g,
    "<path>"
  );

  // Strip Node.js internal module paths (e.g., "node:internal/modules/cjs/loader")
  sanitized = sanitized.replace(/node:internal\/[^\s'",)}\]:]+/g, "<internal>");

  // Match Windows-style absolute paths (C:\, D:\, etc.)
  sanitized = sanitized.replace(/[A-Z]:\\[^\s'",)}\]:]+/g, "<path>");

  return sanitized;
}
