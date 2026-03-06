/**
 * MIME type inference from file extensions.
 */

const MIME_TYPES: Record<string, string> = {
  // HTML
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",

  // JavaScript
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",

  // CSS
  ".css": "text/css; charset=utf-8",

  // JSON
  ".json": "application/json; charset=utf-8",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",

  // Fonts
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",

  // Media
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",

  // Documents
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",

  // Archives
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",

  // WebAssembly
  ".wasm": "application/wasm",

  // Manifest
  ".webmanifest": "application/manifest+json",

  // Source maps
  ".map": "application/json"
};

/**
 * Get the file extension from a path (including the dot).
 */
function getExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "";
  const lastSlash = path.lastIndexOf("/");
  if (lastDot < lastSlash) return "";
  return path.slice(lastDot).toLowerCase();
}

/**
 * Infer MIME type from a file path.
 * Returns undefined if the type is unknown.
 */
export function inferContentType(path: string): string | undefined {
  const ext = getExtension(path);
  return MIME_TYPES[ext];
}

/**
 * Whether a content type represents a text-based format
 * (used to decide text vs binary module storage).
 */
export function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("svg")
  );
}
