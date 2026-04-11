/**
 * Wrangler configuration parsing.
 *
 * Parses wrangler.toml, wrangler.json, and wrangler.jsonc files
 * to extract compatibility settings.
 */

import { parse as parseToml } from "smol-toml";
import type { WranglerConfig } from "./types";
import type { FileSystem } from "./file-system";

/**
 * Parse wrangler configuration from files.
 *
 * Looks for wrangler.toml, wrangler.json, or wrangler.jsonc in the files
 * and extracts compatibility_date and compatibility_flags.
 *
 * @param files - Virtual file system
 * @returns Parsed wrangler config, or undefined if no config file found
 */
export function parseWranglerConfig(
  files: FileSystem
): WranglerConfig | undefined {
  // Try each config file format in order of preference
  const tomlContent = files.read("wrangler.toml");
  if (tomlContent) {
    return parseWranglerToml(tomlContent);
  }

  const jsonContent = files.read("wrangler.json");
  if (jsonContent) {
    return parseWranglerJson(jsonContent);
  }

  const jsoncContent = files.read("wrangler.jsonc");
  if (jsoncContent) {
    return parseWranglerJsonc(jsoncContent);
  }

  return undefined;
}

/**
 * Parse wrangler.toml content
 */
function parseWranglerToml(content: string): WranglerConfig {
  try {
    const config = parseToml(content) as Record<string, unknown>;
    return extractWranglerConfig(config);
  } catch {
    return {};
  }
}

/**
 * Parse wrangler.json content
 */
function parseWranglerJson(content: string): WranglerConfig {
  try {
    const config = JSON.parse(content) as Record<string, unknown>;
    return extractWranglerConfig(config);
  } catch {
    return {};
  }
}

/**
 * Parse wrangler.jsonc content (JSON with comments)
 */
function parseWranglerJsonc(content: string): WranglerConfig {
  try {
    // Strip comments from JSONC
    const jsonContent = stripJsonComments(content);
    const config = JSON.parse(jsonContent) as Record<string, unknown>;
    return extractWranglerConfig(config);
  } catch {
    return {};
  }
}

/**
 * Extract wrangler config fields from parsed config object.
 * Handles both snake_case (toml) and camelCase (json) formats.
 */
function extractWranglerConfig(
  config: Record<string, unknown>
): WranglerConfig {
  const result: WranglerConfig = {};

  // main entry point
  const main = config["main"];
  if (typeof main === "string") {
    result.main = main;
  }

  // compatibility_date (toml) or compatibilityDate (json)
  const date = config["compatibility_date"] ?? config["compatibilityDate"];
  if (typeof date === "string") {
    result.compatibilityDate = date;
  }

  // compatibility_flags (toml) or compatibilityFlags (json)
  const flags = config["compatibility_flags"] ?? config["compatibilityFlags"];
  if (Array.isArray(flags) && flags.every((f) => typeof f === "string")) {
    result.compatibilityFlags = flags;
  }

  return result;
}

/**
 * Strip comments from JSONC content.
 * Handles both single-line (//) and multi-line comments.
 */
function stripJsonComments(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle string literals (don't strip comments inside strings)
    if (
      (char === '"' || char === "'") &&
      (i === 0 || content[i - 1] !== "\\")
    ) {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
      result += char;
      i++;
      continue;
    }

    if (inString) {
      result += char;
      i++;
      continue;
    }

    // Handle single-line comments
    if (char === "/" && nextChar === "/") {
      // Skip until end of line
      while (i < content.length && content[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Handle multi-line comments
    if (char === "/" && nextChar === "*") {
      i += 2;
      // Skip until */
      while (
        i < content.length - 1 &&
        !(content[i] === "*" && content[i + 1] === "/")
      ) {
        i++;
      }
      i += 2; // Skip */
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Check if nodejs_compat flag is enabled in the config.
 */
export function hasNodejsCompat(config: WranglerConfig | undefined): boolean {
  return config?.compatibilityFlags?.includes("nodejs_compat") ?? false;
}
