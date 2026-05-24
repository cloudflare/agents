# Think Skills

Status: implemented MVP; Git-backed sources and R2 write/delete helpers remain
follow-ups

## Problem

Think currently inherits basic skill support from Session: a skill is a context
provider with `get()` metadata and `load(key)` content, surfaced through generic
`load_context` and `unload_context` tools. This is enough to prove the runtime
model, but it is not a first-class Think story:

- Users configure skills indirectly through `configureSession()`.
- Only the R2 provider exists, and it stores keyed text rather than standard
  Agent Skills directories with `SKILL.md`.
- There is no standard parser for the Agent Skills format.
- There is no story for colocated/bundled skills or deploy-to-deploy changes.
- Script execution and permissions are not specified.

We want Think to support the Agent Skills format from
https://agentskills.io/ while staying aligned with Workers constraints and the
existing Session architecture.

## Proposal

Make Think skills a thin first-class layer over Session, not a parallel context
system. The public abstraction is a `SkillSource`: a source can list skill
metadata, load `SKILL.md` instructions, read bundled resources, and report a
deterministic fingerprint.

```ts
import { Think, skills } from "@cloudflare/think";
import productSkills from "./skills" with { type: "skills" };

export class MyAgent extends Think<Env> {
  getSkills() {
    return [
      productSkills,
      skills.r2(this.env.SKILLS_BUCKET, { prefix: "skills/" })
    ];
  }
}
```

The imported value should already be the canonical `SkillSource`; authors should
not need to wrap it in `skills.bundle()`. Helper constructors remain useful for
sources that are not statically imported, such as R2, GitHub-backed sources, and
test manifests.

## Skill Loading

Skills declared through `getSkills()` are available to the agent but are not
always-on instructions. Think loads the skill catalog into the prompt and exposes
`activate_skill`; the model loads full `SKILL.md` instructions only when the
request matches the skill description.

This matches the common Agent Skills pattern used by Claude Code, Cursor, and
Ash: always-on behavior belongs in `getSystemPrompt()`, `instructions.md`, or a
Session context block, while skills are optional procedures that load on demand.
Once activated, a skill remains part of the conversation snapshot. If an
application needs disposable/reclaimable context, it should use Session's
lower-level loadable context providers rather than Think's first-class skills
API.

## Bundled Skills

Colocated skills are the first implementation target:

```ts
import skills from "./skills" with { type: "skills" };
```

Workers do not have a general runtime filesystem, so this is a build-time
feature. The existing `agents/vite` plugin supports `type: "skills"` import
attributes alongside decorator transforms.

The plugin:

- Resolves a directory import such as `./skills`.
- Discovers child directories containing `SKILL.md`.
- Parses YAML frontmatter and markdown body.
- Validates required Agent Skills fields leniently enough for interoperability.
- Bundles `SKILL.md` bodies and resources under `references/`, `scripts/`,
  `assets/`, and a small set of common asset roots such as `graphics/` and
  `fonts/`, with diagnostics for ignored top-level files so unrelated local
  files do not leak into the Worker bundle.
- Records resource size, MIME type when known, and content encoding. Text
  resources are stored as text; binary resources are stored as base64.
- Emits a deterministic fingerprint over metadata, bodies, resource paths, and
  resource contents.
- Generates a plain `SkillSource` module that Think consumes without making
  `agents/vite` depend on `@cloudflare/think`.

Tests and non-Vite environments should be able to use an equivalent manifest
helper directly.

## R2 Skills

R2 is the mutable cloud storage story. The Think R2 skill source models the
standard Agent Skills directory layout:

```text
skills/code-review/SKILL.md
skills/code-review/references/checklist.md
skills/code-review/scripts/run-review.ts
```

This differs from the current `R2SkillProvider`, which stores arbitrary keyed
text plus optional object metadata. The Think source is `skills.r2(bucket,
options)`, which parses `SKILL.md`, enumerates resources, and implements the
same `SkillSource` interface as bundled skills.

The R2 MVP is intentionally read-only and is exposed as `skills.r2(bucket,
options)`:

```ts
skills.r2(this.env.SKILLS_BUCKET, {
  prefix: "skills/",
  skills: ["code-review"],
  fingerprint: "metadata"
});
```

Options:

- `prefix`: bucket prefix containing skill directories.
- `skills`: optional allowlist of parsed skill names.
- `id`: stable source identifier when multiple R2 sources are configured.
- `fingerprint`: `"metadata"` by default, based on listed object keys, etags,
  sizes, and uploaded timestamps. `"content"` reads object contents when a
  stronger fingerprint is needed.
- `refreshIntervalMs`: how often a live R2 source may re-list bucket metadata.
  The default is 60 seconds; `0` checks on every turn.

R2 indexing is intentionally progressive. The source reads `SKILL.md` files and
object metadata to build the catalog and resource descriptors, but resource
bodies are fetched only when `read_skill_resource` asks for a specific path.

Write/delete helpers should come later for apps that build skill-management UIs.
Writes must refresh the Session prompt or update the stored fingerprint so the
catalog does not go stale.

## Git Skills

Git should initially be a distribution and sync source, not the hot path at
agent wake:

- Build time: fetch or vendor a repo path into the bundled manifest.
- Deploy time: sync `github.com/org/repo/path?ref=sha` into R2.
- Runtime advanced: optional GitHub raw/tree API source with pinned refs and
  caching.

The default production recommendation should be pinned refs or R2 sync.
Unpinned remote instructions are a trust and reproducibility risk.

## Runtime Tools

Think should expose skill-specific tools rather than relying only on generic
Session context tools:

- `activate_skill({ name })`: enum-constrained to available skills, returns
  structured skill content and resource listing.
- `read_skill_resource({ name?, path })`: loads bundled resources on demand.
  Callers may pass `{ name, path }` or a qualified path such as
  `other-skill/references/file.md`.
- `run_skill_script({ name, path, input? })`: optional, only registered when a
  script runner is configured. Script paths must live under `scripts/`; omitted
  input defaults to `{}`.

Skill content should be wrapped in identifiable tags with the skill name and
version/fingerprint. This gives compaction and diagnostics something stable to
recognize.

Skill names are globally unique within a Think agent. If two sources expose the
same name, Think should fail during registry loading instead of silently choosing
one source.

## Deploy-To-Deploy Changes

Every source reports a fingerprint. Think stores the last applied fingerprint in
Session or Think config and compares it on startup.

If the fingerprint changes:

- The skill catalog is refreshed before the next turn.
- Already loaded skills remain conversation snapshots.
- New activations use the new skill version.

This avoids silently rewriting old conversations while ensuring new deploys take
effect for future skill activations.

## Scripts And Permissions

The Agent Skills spec defines `allowed-tools` as an optional experimental
frontmatter field. It is a hint, not a full permission model. Think should
define and enforce its own capability envelope.

Scripts should receive explicit capabilities rather than ambient access to the
agent. The first implementation keeps this concrete: runner options are the
permission boundary.

```ts
skills.workerScriptRunner({
  loader: this.env.LOADER,
  workspaceInstance: this.workspace,
  tools: {
    search_docs: this.getTools().search_docs
  }
});
```

The default is useful but not ambiently powerful: no network and no tools, with
read-only workspace access when `workspaceInstance` is provided, and a 30 second
script timeout. Tool access is explicit; Think does not expose the full turn
toolset to a script by default. Workspace access is `"none"`, `"read"`, or
`"read-write"`, with
`workspace: "read-write"` required for mutating filesystem operations.

JavaScript scripts run through the existing codemode Dynamic Worker execution
path. TypeScript scripts are first compiled with `@cloudflare/worker-bundler`,
then run through the same codemode path so tool and workspace namespaces stay
consistent. Python scripts with `.py` extensions run as Python Dynamic Workers
with the `python_workers` compatibility flag. Bash scripts with `.sh` or
`.bash` extensions run through `just-bash`, which provides a simulated shell and
virtual filesystem instead of ambient host shell access. Python Workers have
slower cold starts than JavaScript Workers, so JavaScript remains the preferred
runtime for one-off generated code.

For Python and Bash, the primary script contract is path-based, matching
CLI-oriented Agent Skills. The runner mounts:

- `/skill`: `SKILL.md` and bundled skill resources.
- `/input.json`: the `run_skill_script` input, defaulting to `{}`.
- `/context.json`: skill metadata.
- `/workspace`: reserved for workspace-backed files; direct workspace access is
  still governed by the explicit workspace permission.

JavaScript and TypeScript scripts use `@cloudflare/worker-bundler` virtual module
aliases for partial `fs`/`node:fs`, `fs/promises`, and `path` compatibility,
including static imports and dynamic `import("node:fs")`. Sync FS reads are
limited to embedded files (`/skill`, `/input.json`, and `/context.json`).
Workspace reads and writes cross the host Worker boundary, so they are async-only
through `fs.promises`; sync workspace access throws a clear error. Writes to
`/output` create scratch artifacts returned by `run_skill_script` and do not
mutate durable workspace state. Async writes to `/workspace` require
`workspace: "read-write"`.

For Think-specific compatibility, JavaScript and TypeScript scripts may still
export a function:

```ts
export default async function run(input, ctx) {
  return input;
}
```

Python scripts may use the equivalent compatibility contract:

```py
def run(input, ctx):
    return input
```

`input` defaults to `{}` when omitted. `ctx` starts with skill metadata. For
function-style scripts, workspace and tools are available through
runtime-specific namespaces when enabled by the runner. JavaScript and
TypeScript use the codemode sandbox namespaces; Python exposes
`tools.<name>(input)`, `tools.call(name, input)`, and `workspace.read_file()`,
`workspace.list_files()`, `workspace.glob()`, and `workspace.write_file()`
according to the configured workspace permission. Bash exposes workspace access
through commands such as `workspace-read`, `workspace-list`, and
`workspace-glob`, while explicit tools are exposed through a
`tool <name> <json>` command.

## MVP

The first implementation stays narrow:

1. Define `SkillSource`, `SkillRegistry`, skill metadata, and fingerprint types.
2. Implement bundled-manifest support and tests without requiring the Vite
   transform.
3. Add `getSkills()` to Think.
4. Support on-demand skill activation.
5. Add prompt fingerprint refresh for catalog changes.
6. Add `activate_skill` and `read_skill_resource`.
7. Add the `type: "skills"` import-attribute transform in `agents/vite`.
8. Add a read-only R2-backed Agent Skills source.
9. Add optional script execution for JavaScript/TypeScript, Python, and Bash.

Git-backed sources should follow once the source story is proven.

## Alternatives

### Keep Skills Only In Session

This preserves the existing architecture but leaves Think users with generic
context tools, no Agent Skills parser, no bundled skill story, and no
deploy-change handling.

### Make `skills.bundle(imported)` Required

This gives a place for runtime options, but it makes the flagship API noisier.
The import attribute can return the correct type directly. Runtime helpers
should remain optional for tests and non-import sources.

### Live Git Provider First

This is attractive for sharing skills, but it introduces auth, caching, rate
limits, and remote trust before the local runtime shape is settled. Git should
start as build/deploy-time sync.

### Execute Scripts As Shell Commands

This matches local coding-agent expectations, but Think runs on Workers.
Scripts need a sandbox/runtime abstraction and explicit capabilities. Direct
ambient Bash/Python execution is not the right default.

## Decision

Use bundled skills plus Think-native activation tools as the primary skills API,
with `skills.r2(...)` as the first runtime source. Keep R2 read-only for now.
Git-backed sources remain a follow-up layer after the core source API is
validated.
