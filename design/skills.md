# Agent Skills

Status: implemented. Skills are files; `agents/skills` parses them and loads
them from a Computer Workspace, R2, or a manifest. The script runner is
experimental.

## Model

A skill is a directory with a `SKILL.md` file, as defined by the
[Agent Skills spec](https://agentskills.io/specification):

```text
<skills root>/
  release-notes/
    SKILL.md                 # YAML frontmatter + Markdown instructions
    references/style-guide.md
    scripts/format.js
    assets/logo.png
```

Skills are meant to be an emergent property of a Workspace: write a
`SKILL.md` into `/workspace/.agents/skills/<name>/` and the agent has a new
skill on its next turn. There is no build step, no registry to update, and no
copy to keep in sync. Other stores (R2, code) follow the same layout.

## Parsing

`parseSkill(markdown, { directory, mode })` in `agents/skills/markdown.ts`
is the one parser (frontmatter rules live in `skill.ts`, which does not load
`yaml`). It returns `{ ok: true, value, warnings }` or `{ ok: false, error }`;
it never throws and never returns `null`.

Spec rules:

- `name`: 1-64 characters after NFKC normalization, lowercase letters, digits,
  and hyphens; no leading, trailing, or consecutive hyphens; must equal the
  directory name.
- `description`: required, 1-1024 characters.
- `compatibility`: 1-500 characters when present.
- `license`: non-empty string when present.
- `metadata`: a string-to-string map. Scalar values (`version: 1.0`) become
  strings; nested values break the rule.
- `allowed-tools`: a space-separated string (a YAML list is also accepted),
  parsed into `allowedTools: string[]`.

Two modes:

- `strict` (default for direct calls) fails on any broken rule. It is the
  validator: authoring tools and the examples' "add skill" use it.
- `lenient` (every source) follows the spec's
  [guide for agents](https://agentskills.io/client-implementation/adding-skills-support):
  a skill that breaks a rule still loads, and each broken rule is returned as
  a warning (catalog diagnostic `SkillWarning`). Invalid optional fields are
  dropped. A missing `name` falls back to the directory. Frontmatter that
  fails only because of unquoted `: ` in a value is re-read with those values
  quoted.

Both modes reject a skill with no `description`, frontmatter that is not a
YAML mapping, or a `name` that is not a safe single path segment (no `/`,
`\`, NUL, control characters, `.`, or `..`). Every `SkillName` is safe to use
as a directory, an enum value, and the first segment of a qualified resource
path. Because a lenient name can differ from its directory, the Workspace and
R2 sources remember which directory each name came from and read resources
from there.

Frontmatter keys the spec does not define are kept in `extraFields` rather
than rejected. Clients add their own (`disable-model-invocation`,
`user-invocable`), and rejecting them would break skills written for other
agents. `disable-model-invocation: true` (top-level or in `metadata`) hides a
skill from the model.

Resource paths are parsed with `parseSkillResourcePath`: relative, normalized,
inside the skill, and never `SKILL.md`. A resource's `kind` comes from its
top-level directory (`scripts/`, `references/`, `assets/`, else `file`) and its
encoding from its extension.

## Sources

```ts
interface SkillSource {
  readonly id: string;
  list(): Promise<SkillResult<SkillListing, SkillSourceError>>;
  readResource(
    skill: SkillName,
    path: SkillResourcePath
  ): Promise<
    SkillResult<SkillResource, SkillResourceNotFoundError | SkillSourceError>
  >;
}
```

`list()` returns every valid skill with its resource list, plus the skills
that failed to parse (`invalid`). Sources are listed again whenever a catalog
loads, so there is no separate fingerprint or refresh protocol on the source.

| Source                                | Store                                                   |
| ------------------------------------- | ------------------------------------------------------- |
| `workspace(ws, { root })`             | Computer Workspace, default `/workspace/.agents/skills` |
| `r2(bucket, { prefix, skills, ... })` | R2; caches a listing for `refreshIntervalMs` (60 s)     |
| `manifest({ id, skills })`            | Skills defined in code (tests, small fixed sets)        |

`fromManifest` is a deprecated alias of `manifest`.

Workspace and R2 share one directory indexer (`indexSkillTree`): every
`<dir>/SKILL.md` one level below the root is a skill, every other file in
`<dir>` is a resource, and `.git`, `node_modules`, and `.DS_Store` are
ignored. Workspace skills also report their absolute `location`, so an agent
with a shell can run their scripts in place.

Seeding a Workspace from R2 or from the repo is Computer's job, not this
module's. Examples write their starter skills on start, with a TODO to use
Computer's loader once it exists.

## Catalog

`loadSkillCatalog(sources)` merges sources in order. The first source to list
a name wins. Failures are diagnostics, never errors:

- `InvalidSkill`: a `SKILL.md` broke a spec rule.
- `SourceFailed`: a source could not be listed (including one that threw).
- `DuplicateSkill`: a later source listed a name already provided.

The catalog renders the system-prompt text, activation output
(`<skill_content name location>` plus the resource list), and resource output
(`<skill_resource>`). Only files the source listed are readable. `fingerprint`
is a hash of the prompt text, so hosts refresh the system prompt exactly when
the catalog the model sees changes.

Framework adapters wrap a catalog, so every framework shows the model the same
tools and text:

- `createSkillTools(catalog, { scriptRunner })` from
  `agents/skills/tools/ai-sdk`: AI SDK `activate_skill`,
  `read_skill_resource`, and `run_skill_script`. Used by Think.
- `skills(sources)` in `agents/harness/pi`: the same tools as a pi-durable
  extension.

## Think

`getSkills()` returns sources. Think loads the catalog on start and again
before every turn, passing the previous catalog so a failing source keeps its
last skills. The catalog renders in a `think_skills` context block declared
`whenChanged: "remind"`: a changed catalog does not rebuild the frozen system
prompt (which would invalidate the provider's prompt cache). It goes to the
model as a reminder after the cached prefix, and is folded in at the next
rebuild (compaction or clearing history). An overridden `getSystemPrompt()`
renders above the context blocks, so registering skills never removes it.

Think used to copy sources into the Workspace (`skillWorkspace`) and bundle
skills at build time (`agents:skills` and the Vite plugin). Both are gone:
skills in the Workspace are read directly, and Computer will own seeding.

## Scripts

With a Workspace, scripts are files and the model runs them with the
Workspace's `exec` tool from the skill's `location`. That is the preferred
path.

For skills that live elsewhere (R2, a manifest), `runner()` from
`agents/skills/runner` (re-exported by Think as `skills.runner`) enables
`run_skill_script`. It is its own entry point because `just-bash` and
`@cloudflare/codemode` do not tree-shake: kept in `agents/skills`, every
import of the parser paid about 300 KiB gzipped. It is experimental and carries a TODO to move to
Computer. Options are the permission boundary: no network and no tools by
default, read-only workspace access when `workspaceInstance` is given, and a
30 second timeout. One host bridge (`SkillScriptHostBridge`), built fresh per
run, enforces capabilities for every runtime:

- JavaScript: function-style `export default async function run(input, ctx)`
  with `ctx = { skill, files, workspace, tools, output }`, run in a Dynamic
  Worker through codemode. There is no in-Worker bundler, so TypeScript and
  scripts that import sibling files must be compiled before they are stored.
- Python (`.py`): a Python Dynamic Worker; `def run(input, ctx)` or CLI-style.
- Bash (`.sh`, `.bash`): `just-bash`.

Python and Bash use the path-based contract: `/skill`, `/input.json`,
`/context.json`, and `/output`.

## Alternatives

### Bundle skills at build time

The `agents:skills` Vite import embedded skills in the Worker bundle. It made
skills a build artifact: changing one meant a deploy, and the agent could not
author its own. Removed in favor of Workspace files.

### Project sources into the Workspace

`skillWorkspace` copied source skills into `/workspace/.agents/skills` and
tracked a projection fingerprint. The sources stayed authoritative, so a skill
written only in the Workspace was never discovered. Reading the Workspace
directly removes the two-copy problem.

### Strict parsing everywhere

Rejecting every skill that breaks a rule makes mistakes loud, but skills
written for other agents often have names that do not match their folder or
are not lowercase. The spec's own guide for agents recommends warning and
loading those. Sources parse leniently with diagnostics; `parseSkill()`
defaults to strict for validation.
