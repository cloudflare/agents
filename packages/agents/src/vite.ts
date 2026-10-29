import babel from "@rolldown/plugin-babel";
import type { Plugin } from "vite";

const TURNDOWN_STUB_ID = "\0agents:turndown-stub";
const TURNDOWN_STUB_MESSAGE =
  "The Agents Vite plugin stubbed the 'turndown' package to keep Workers " +
  "bundles compatible with just-bash. If your app uses turndown directly, " +
  "configure the plugin with agents({ stubTurndown: false }).";

// `just-bash` (pulled in by the workspace bash tool / skill runner) statically
// depends on `turndown`, whose ESM build runs a top-level `require()` on its
// Node DOM fallback. Workers is ESM with no global `require`, so the module
// throws at startup — even when the bash tool is never used. turndown is only
// needed by just-bash's niche `html-to-markdown` command, so we replace it with
// a diagnostic stub by default to keep Workers deploys clean. Opt out with
// `agents({ stubTurndown: false })` if you rely on turndown elsewhere.
function turndownStubPlugin(): Plugin {
  return {
    name: "agents-turndown-stub",
    enforce: "pre",
    resolveId(source) {
      if (source === "turndown") return TURNDOWN_STUB_ID;
      return null;
    },
    load(id) {
      if (id !== TURNDOWN_STUB_ID) return null;
      return `const message = ${JSON.stringify(TURNDOWN_STUB_MESSAGE)};
class TurndownService {
  constructor() {}
  use() { return this; }
  addRule() { return this; }
  keep() { return this; }
  remove() { return this; }
  turndown() { throw new Error(message); }
}
export default TurndownService;
`;
    }
  };
}

const REMOVED_SKILLS_IMPORT_MESSAGE =
  'The "agents:skills" import has been removed. Skills are now files: store them in a Computer Workspace ' +
  "and return skills.workspace(this.workspace) from getSkills(), or load them with skills.r2(bucket) or " +
  "skills.manifest({ id, skills }). See https://developers.cloudflare.com/agents/skills/";

// `agents:skills` used to bundle a skills directory at build time. Fail with
// a migration message instead of Vite's generic "failed to resolve import".
function removedSkillsImportPlugin(): Plugin {
  return {
    name: "agents-removed-skills-import",
    enforce: "pre",
    resolveId(source) {
      if (source === "agents:skills" || source.startsWith("agents:skills/")) {
        this.error(REMOVED_SKILLS_IMPORT_MESSAGE);
      }
      return null;
    }
  };
}

export interface AgentsPluginOptions {
  /**
   * Replace `turndown` with a diagnostic stub so `just-bash` (workspace bash
   * tool / skill runner) doesn't drag turndown's `require()`-using DOM fallback
   * into the Worker's module-init path and break deploys. Enabled by default.
   * Set to `false` if your app uses turndown directly and needs the real
   * implementation.
   */
  stubTurndown?: boolean;
}

/**
 * Vite plugin for Agents SDK projects.
 *
 * Handles TC39 decorator transforms (Oxc doesn't support them yet, oxc#9170) so
 * `@callable()` works at runtime, and stubs `turndown` to keep Workers
 * deploys clean. Will grow to cover other
 * Agents-specific build concerns as needed.
 */
export default function agents(options: AgentsPluginOptions = {}): Plugin[] {
  const { stubTurndown = true } = options;
  return [
    ...(stubTurndown ? [turndownStubPlugin()] : []),
    removedSkillsImportPlugin(),
    babel({
      presets: [
        {
          preset: () => ({
            plugins: [
              ["@babel/plugin-proposal-decorators", { version: "2023-11" }]
            ]
          }),
          rolldown: { filter: { code: "@" } }
        }
      ]
    }) as unknown as Plugin
  ];
}
