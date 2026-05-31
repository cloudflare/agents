/**
 * Codemode skill interface.
 *
 * Skills are reusable code patterns that combine connector methods.
 * Think (or any other system) implements skill sources; codemode consumes them.
 *
 * Connectors provide raw capability. Skills provide recipes.
 */

/** A single codemode skill — a reusable code pattern. */
export interface CodemodeSkill {
  /** Unique skill name. Appears in codemode.search results. */
  name: string;
  /** Short description for search/catalog. */
  description: string;
  /** The code pattern — an async arrow function string. */
  code: string;
  /** JSON Schema for skill input parameters. */
  inputSchema?: unknown;
  /** Optional longer markdown instructions shown on describe. */
  instructions?: string;
}

/** A source of codemode skills. Think implements this; codemode consumes it. */
export interface CodemodeSkillSource {
  /** Stable identifier for this source. */
  id: string;
  /** List all skills from this source. */
  list(): Promise<CodemodeSkill[]>;
  /** Load a specific skill by name. */
  load?(name: string): Promise<CodemodeSkill | null>;
}
