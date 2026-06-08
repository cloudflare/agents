export interface SkillDescriptor {
  name: string;
  description: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  sourceId?: string;
  version?: string;
}

export interface SkillContent extends SkillDescriptor {
  body: string;
  rawContent?: string;
  resources?: SkillResourceDescriptor[];
}

export interface SkillResourceDescriptor {
  path: string;
  kind: "reference" | "script" | "asset" | "file";
  size?: number;
  encoding?: "text" | "base64";
  mimeType?: string;
  /**
   * Set when a script resource was compiled to a self-contained JavaScript
   * module ahead of time — by the Agents Vite plugin for bundled skills, or via
   * `compileSkillScript` from `agents/skills/compile` for R2/dynamic skills. The
   * runtime runs precompiled scripts directly; the runtime ships no in-Worker
   * bundler, so non-precompiled TypeScript or multi-file scripts cannot run.
   */
  precompiled?: boolean;
}

export interface SkillResource extends SkillResourceDescriptor {
  content: string;
}

export interface SkillScriptContext {
  skill: SkillDescriptor;
}

/**
 * The `ctx` object passed as the second argument to function-style JS/TS
 * skill scripts (`export default async function run(input, ctx)`).
 *
 * Capabilities are gated by the runner: `workspace` throws unless workspace
 * access is enabled, and `tools` only resolves tools the runner was given.
 */
export interface SkillRunContext {
  /** Metadata for the skill that owns this script. */
  skill: SkillDescriptor;
  /** Text bundled resources by relative path (e.g. `references/style-guide.md`). */
  files: Record<string, string>;
  /** Workspace access, gated by the runner's `workspace` permission. */
  workspace: {
    readFile(path: string): Promise<string | null>;
    listFiles(path?: string): Promise<unknown>;
    glob(pattern: string): Promise<unknown>;
    stat(path: string): Promise<{ type: string; size: number } | null>;
    writeFile(path: string, content: string): Promise<void>;
  };
  /** Explicitly granted tools: `tools.call(name, input)` or `tools.<name>(input)`. */
  tools: {
    call(name: string, input?: unknown): Promise<unknown>;
  } & Record<string, (input?: unknown) => Promise<unknown>>;
  /** Scratch artifacts returned to the model as `outputFiles`. */
  output: {
    writeFile(name: string, content: string): Promise<void>;
  };
}

export interface SkillScriptRequest {
  skill: SkillContent;
  path: string;
  source: string;
  input: unknown;
  resources?: SkillResource[];
}

export interface SkillScriptRunner {
  run(request: SkillScriptRequest): Promise<unknown>;
}

export interface SkillSource {
  id: string;
  fingerprint: string;
  list(): Promise<SkillDescriptor[]>;
  load(name: string): Promise<SkillContent | null>;
  readResource?(name: string, path: string): Promise<SkillResource | null>;
  refresh?(): Promise<void>;
}

export interface SkillManifestResource extends SkillResourceDescriptor {
  content: string;
}

export interface SkillManifestEntry {
  name: string;
  description: string;
  body: string;
  rawContent?: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  version?: string;
  resources?: SkillManifestResource[];
}

export interface SkillManifest {
  id: string;
  fingerprint: string;
  skills: SkillManifestEntry[];
}

export interface SkillRegistrySnapshot {
  fingerprint: string;
  catalogPrompt: string | null;
}

export function validateSkillResourcePath(path: string): string | null {
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return `Skill resource path must be a normalized relative path: ${path}`;
  }
  return null;
}
