import type { SkillResourceKind } from "./resource";
import type { Skill } from "./skill";

// TODO: Store skills in a `@cloudflare/computer` Workspace and run their
// scripts with the Workspace runtime (the agent's shell) instead of a
// skill-specific runner. `SkillScriptRunner` stays for R2/manifest skills
// until Computer covers that.

/** A request to run one bundled skill script. */
export interface SkillScriptRequest {
  /** The skill that owns the script. */
  readonly skill: Skill;
  /** Script path relative to the skill, under `scripts/`. */
  readonly path: string;
  /** Script source. */
  readonly source: string;
  /** JSON input from the model. */
  readonly input: unknown;
  /** Other files bundled with the skill, mounted for the script. */
  readonly resources?: readonly SkillScriptFile[];
}

/** A bundled file made available to a running script. */
export interface SkillScriptFile {
  /** Path relative to the skill directory. */
  readonly path: string;
  /** UTF-8 text, or base64 when `encoding` is `"base64"`. */
  readonly content: string;
  /** Defaults to `"text"`. */
  readonly encoding?: "text" | "base64";
  /** Role of the file in the skill. */
  readonly kind?: SkillResourceKind;
}

/** Runs skill scripts. Enables Think's `run_skill_script` tool. */
export interface SkillScriptRunner {
  /**
   * Run a script.
   *
   * @param request - The script and its skill.
   * @returns The script's result.
   * @throws When the script fails; the tool reports the message to the model.
   */
  run(request: SkillScriptRequest): Promise<unknown>;
}

/** Skill metadata passed to running scripts. */
export interface SkillScriptContext {
  /** The skill that owns the script. */
  readonly skill: {
    readonly name: string;
    readonly description: string;
    readonly license?: string;
    readonly compatibility?: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly allowedTools: readonly string[];
  };
}

/**
 * The `ctx` object passed as the second argument to function-style JS
 * skill scripts (`export default async function run(input, ctx)`).
 *
 * Capabilities are gated by the runner: `workspace` throws unless workspace
 * access is enabled, and `tools` only resolves tools the runner was given.
 */
export interface SkillRunContext {
  /** Metadata for the skill that owns this script. */
  skill: SkillScriptContext["skill"];
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
