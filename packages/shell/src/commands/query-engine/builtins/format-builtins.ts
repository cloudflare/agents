/**
 * Format-related jq builtins (@ prefixed)
 *
 * Handles encoding/formatting functions like @base64, @uri, @csv, @json, etc.
 */

import type { QueryValue } from "../value-operations";
import { getValueDepth } from "../value-operations";

// Default max depth for nested structures
const DEFAULT_MAX_JQ_DEPTH = 2000;

/**
 * Handle format builtins (those starting with @).
 * Returns null if the builtin name is not a format builtin handled here.
 */
export function evalFormatBuiltin(
  value: QueryValue,
  name: string,
  maxDepth?: number
): QueryValue[] | null {
  switch (name) {
    case "@base64":
      if (typeof value === "string") {
        // Use Buffer for Node.js, btoa for browser
        if (typeof Buffer !== "undefined") {
          return [Buffer.from(value, "utf-8").toString("base64")];
        }
        return [btoa(value)];
      }
      return [null];

    case "@base64d":
      if (typeof value === "string") {
        // Use Buffer for Node.js, atob for browser
        if (typeof Buffer !== "undefined") {
          return [Buffer.from(value, "base64").toString("utf-8")];
        }
        return [atob(value)];
      }
      return [null];

    case "@uri":
      if (typeof value === "string") {
        // encodeURIComponent doesn't encode !'()*~ but jq encodes !'()*
        return [
          encodeURIComponent(value)
            .replace(/!/g, "%21")
            .replace(/'/g, "%27")
            .replace(/\(/g, "%28")
            .replace(/\)/g, "%29")
            .replace(/\*/g, "%2A")
        ];
      }
      return [null];

    case "@urid":
      if (typeof value === "string") {
        return [decodeURIComponent(value)];
      }
      return [null];

    case "@csv": {
      if (!Array.isArray(value)) return [null];
      const csvEscaped = value.map((v) => {
        if (v === null) return "";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "number") return String(v);
        // Only quote strings that contain special characters (comma, quote, newline)
        const s = String(v);
        if (
          s.includes(",") ||
          s.includes('"') ||
          s.includes("\n") ||
          s.includes("\r")
        ) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      });
      return [csvEscaped.join(",")];
    }

    case "@tsv": {
      if (!Array.isArray(value)) return [null];
      return [
        value
          .map((v) =>
            String(v ?? "")
              .replace(/\t/g, "\\t")
              .replace(/\n/g, "\\n")
          )
          .join("\t")
      ];
    }

    case "@json": {
      // Check depth to avoid V8 stack overflow during JSON.stringify
      const effectiveMaxDepth = maxDepth ?? DEFAULT_MAX_JQ_DEPTH;
      if (getValueDepth(value, effectiveMaxDepth + 1) > effectiveMaxDepth) {
        return [null];
      }
      return [JSON.stringify(value)];
    }

    case "@html":
      if (typeof value === "string") {
        return [
          value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/'/g, "&apos;")
            .replace(/"/g, "&quot;")
        ];
      }
      return [null];

    case "@sh":
      if (typeof value === "string") {
        // Shell escape: wrap in single quotes, escape any single quotes
        return [`'${value.replace(/'/g, "'\\''")}'`];
      }
      return [null];

    case "@text":
      if (typeof value === "string") return [value];
      if (value === null || value === undefined) return [""];
      return [String(value)];

    default:
      return null;
  }
}
