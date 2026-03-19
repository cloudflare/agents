/**
 * Local config — stored at ~/.think/config.json
 *
 * {
 *   "server": "ws://localhost:8787",
 *   "provider": "anthropic",
 *   "model": "claude-opus-4-6",
 *   "apiKey": "sk-ant-..."
 * }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

export interface ThinkConfig {
  server: string;
  session: string;
  provider: string;
  model: string;
  apiKey?: string;
  /** For opencode-cloudflare provider: gateway base URL */
  gatewayUrl?: string;
  /** GitHub PAT — sent to server for git operations (clone, push, etc.) */
  githubToken?: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".think");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS: ThinkConfig = {
  server: "ws://localhost:8787",
  session: "new",
  provider: "anthropic",
  model: "claude-opus-4-6"
};

/**
 * Try to read the OpenCode Cloudflare auth token from
 * ~/.local/share/opencode/auth.json
 */
export function readOpenCodeToken(): string | undefined {
  const candidates = [
    process.env.OPENCODE_CLOUDFLARE_AUTH_FILE,
    process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
      : undefined,
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      // Look for opencode.cloudflare.dev entries
      for (const key of Object.keys(raw)) {
        if (key.includes("opencode.cloudflare.dev")) {
          const record = raw[key];
          if (record?.token) return record.token;
        }
      }
    } catch {
      // skip
    }
  }

  // Also check env override
  return process.env.OPENCODE_CLOUDFLARE_TOKEN?.trim() || undefined;
}

/**
 * Resolve GitHub token from config, env, or gh CLI auth.
 */
export function resolveGithubToken(config: ThinkConfig): string | undefined {
  if (config.githubToken) return config.githubToken;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // Try gh CLI (v2+ stores tokens in system keychain, not hosts.yml)
  try {
    const token = execSync("gh auth token", { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not logged in
  }

  return undefined;
}

export function loadConfig(): ThinkConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const saved = JSON.parse(raw);
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Partial<ThinkConfig>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Merge with existing
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    // no existing config
  }

  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n");
}

export function applyCliArgs(base: ThinkConfig, args: string[]): { config: ThinkConfig; print: boolean; mode: "text" | "json"; message?: string } {
  const config = { ...base };
  let print = false;
  let mode: "text" | "json" = "text";
  let message: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        config.server = args[++i];
        break;
      case "--session":
        config.session = args[++i];
        break;
      case "--provider":
        config.provider = args[++i];
        break;
      case "--model":
        config.model = args[++i];
        break;
      case "--api-key":
        config.apiKey = args[++i];
        break;
      case "--github-token":
        config.githubToken = args[++i];
        break;
      case "-p":
      case "--print":
        print = true;
        break;
      case "--mode":
        mode = args[++i] as "text" | "json";
        if (mode === "json") print = true;
        break;
      case "--save":
        // Save current config (after all flags parsed)
        break;
      default:
        if (!args[i].startsWith("--")) {
          message = args.slice(i).join(" ");
          i = args.length;
        }
    }
  }

  // Message without -p implies print mode
  if (message && !print) print = true;

  // --save flag persists config
  if (args.includes("--save")) {
    const { apiKey, ...rest } = config;
    // Save apiKey too if explicitly provided
    if (args.includes("--api-key")) {
      saveConfig({ ...rest, apiKey });
    } else {
      saveConfig(rest);
    }
    console.error(`Config saved to ${CONFIG_FILE}`);
  }

  return { config, print, mode, message };
}
