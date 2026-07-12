# 17 — Skills: registry, catalog, activation tools

Original: `agents/skills/*` (registry, manifest, frontmatter, r2, runner) plus
Think's `getSkills()` wiring. Skills are the Agent Skills directory format:
on-demand instruction documents with resources, surfaced to the model as a
catalog + `activate_skill` / `read_skill_resource` tools. Script running stays
behind the Sandbox port (seam only).

## Model

```ts
export interface SkillDefinition {
  name: string;                        // directory name, unique
  description: string;                 // from SKILL.md frontmatter
  instructions: string;                // SKILL.md body (markdown)
  resources: Record<string, SkillResource>;   // relative path → resource
  metadata?: Record<string, unknown>;
}
export interface SkillResource { content: string; encoding: "utf8" | "base64"; mediaType?: string }
export interface SkillSource {
  id: string;
  list(): Promise<SkillDefinition[]>;
}
```

### Sources
- `fromManifest(defs: SkillDefinition[])` — static source (what a bundler
  plugin would emit).
- `fromWorkspace(ws: Workspace, prefix)` — reads `<prefix>/<skill>/SKILL.md`
  (+ sibling files as resources) out of a workspace; parses frontmatter
  (`---\nname: ...\ndescription: ...\n---` — a minimal YAML subset: top-level
  `key: value` strings only).
- R2/remote sources are future adapters.

### Registry semantics (original behavior)
- Sources applied in order; **first source to register a name wins**;
  duplicates skipped with a warning (collect warnings, don't throw).
- A failing source (list() throws) is skipped with a warning; the agent still
  starts.

## Prompt & tools

- **Catalog block** (appended to system prompt when ≥1 skill):
  a deterministic list of `name — description` lines under a short preamble
  explaining `activate_skill`. Skills are on-demand instructions, NOT
  always-on prompt text.
- `activate_skill { name }` → returns the skill's full instructions (this is
  the tool output; the model now "has" the skill for this conversation).
  Unknown name → error value listing valid names.
- `read_skill_resource { name?, path }` → returns a resource. Accepts
  `{ name, path }` or a qualified `skillname/relative/path` in `path` alone
  (cross-skill references). Text resources returned directly; binary as
  base64 with mediaType noted.
- Both tools get `metadata.capability = "skills"`.

## Proposed interface

```ts
export interface SkillRegistry {
  skills(): SkillDefinition[];
  get(name: string): SkillDefinition | undefined;
  warnings(): string[];
  catalogBlock(): string;               // "" when empty
  tools(): ToolSet;                     // {} when empty
}
export function createSkillRegistry(sources: SkillSource[]): Promise<SkillRegistry>;
export function fromManifest(defs: SkillDefinition[]): SkillSource;
export function fromWorkspace(ws: Workspace, prefix?: string): SkillSource;
export function parseFrontmatter(md: string): { attributes: Record<string, string>; body: string };
```

## Tests
- frontmatter parsing (with/without block, unknown keys preserved).
- source order precedence + duplicate warning; failing source skipped.
- workspace source discovers skills + resources.
- catalog block determinism; tools absent when no skills.
- activate returns instructions; unknown name error lists candidates.
- read_skill_resource: qualified path form; binary encoding note.
