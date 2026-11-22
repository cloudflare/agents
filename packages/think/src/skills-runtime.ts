/**
 * The skills a Think agent loads from `getSkills()`: the catalog, its prompt
 * block and the skill tools for each turn.
 *
 * In memory only: the catalog, the sources and the warnings already logged.
 * Sources keep their own storage (a Workspace, R2, a manifest), and the
 * catalog is listed again before every turn.
 */

import type { ToolSet } from "ai";
import type { ContextBlocks } from "agents/context";
import { formatSkillDiagnostic, loadSkillCatalog } from "agents/skills";
import type {
  SkillCatalog,
  SkillScriptRunner,
  SkillSource
} from "agents/skills";
import { createSkillTools } from "agents/skills/tools/ai-sdk";

/**
 * Label of the context block that carries the skill catalog.
 *
 * @internal
 */
export const SKILLS_CONTEXT_LABEL = "think_skills";

/** @internal */
export class ThinkSkills {
  #sources: readonly SkillSource[] = [];
  #catalog: SkillCatalog | null = null;
  readonly #warnings = new Set<string>();

  /**
   * Load the catalog and register its context block. A failing source never
   * stops the agent from starting: the error is logged and skills stay off.
   */
  async initialize(
    getSources: () => SkillSource[] | Promise<SkillSource[]>,
    context: ContextBlocks
  ): Promise<void> {
    try {
      const sources = await getSources();
      if (sources.length === 0) return;

      this.#sources = sources;
      await this.#load();

      // `whenChanged: "remind"` keeps the frozen system prompt (and the
      // provider's prefix cache) stable when skills change mid-conversation.
      // The new catalog goes out as a reminder after the cached prefix, and
      // is folded into the system prompt at the next rebuild (compaction or
      // clearing history).
      await context.addBlock({
        label: SKILLS_CONTEXT_LABEL,
        description: "Think skills: available skill catalog",
        whenChanged: "remind",
        provider: {
          get: async () => this.#catalog?.prompt() ?? "No skills are available."
        }
      });
    } catch (error) {
      console.warn(
        `[think] Failed to initialize skills; continuing without them: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List the sources again. Sources are live (a Workspace, R2), so a failure
   * keeps the last good catalog rather than breaking the turn. The skills
   * block is a reminder block, so a changed catalog reaches the model without
   * rebuilding the frozen system prompt.
   */
  async refresh(): Promise<void> {
    if (!this.#catalog) return;
    try {
      await this.#load();
    } catch (error) {
      console.warn(
        `[think] Failed to refresh skills; using last known catalog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** The skill tools for a turn, or none when no catalog loaded. */
  tools(scriptRunner: () => SkillScriptRunner | null): ToolSet {
    return this.#catalog
      ? createSkillTools(this.#catalog, { scriptRunner: scriptRunner() })
      : {};
  }

  /** Load the catalog from every source and log new diagnostics. */
  async #load(): Promise<void> {
    // `previous` keeps a source's last skills when it fails to list, so a
    // transient outage (an R2 blip) does not drop them for a turn.
    const catalog = await loadSkillCatalog(this.#sources, {
      previous: this.#catalog ?? undefined
    });
    for (const diagnostic of catalog.diagnostics) {
      this.#warnOnce(formatSkillDiagnostic(diagnostic));
    }
    this.#catalog = catalog;
  }

  /**
   * Log a skills warning once per object lifetime, so a new problem after a
   * deploy still surfaces while the same warning is not repeated every turn.
   */
  #warnOnce(warning: string): void {
    if (this.#warnings.has(warning)) return;
    this.#warnings.add(warning);
    console.warn(`[think] ${warning}`);
  }
}
