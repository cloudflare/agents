// Ambient types for the Agents Vite plugin's `agents:skills` virtual modules.
//
// `import skills from "agents:skills"` (or `"agents:skills/<dir>"`) is resolved
// at build time by the `agents()` Vite plugin to a bundled `SkillSource`. This
// declaration gives those imports a type.
//
// It is referenced from the package's main type entry, so importing anything
// from `agents` (directly, or transitively via `@cloudflare/think` /
// `@cloudflare/ai-chat`) brings it into scope. For a file that imports only the
// specifier, add:
//
//   /// <reference types="agents/skills-module" />

declare module "agents:skills" {
  const source: import("agents/skills").SkillSource;
  export default source;
}

declare module "agents:skills/*" {
  const source: import("agents/skills").SkillSource;
  export default source;
}
