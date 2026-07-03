# TOOLS.md — agent-think's tool surface

The model sees **exactly four tools: `read`, `write`, `edit`, `bash`.** Everything else — listing,
searching, deleting, globbing — is a bash one-liner. Tools run against the DO-owned workspace;
`bash` fans out to two exec backends. Total definition cost: ~1,100 tokens per model call
(vs ~1,733 for the 8-tool surface we shipped with).

## The four tools

### read

Paged file read through the workspace VFS.
`{ path, offset? (1-indexed line), limit? (lines) }`

- Head-truncated to **800 lines / 32 KB**, whichever hits first. Limits are interpolated into the
  tool description from the same constants the code enforces, so prompt and behavior cannot drift.
- Streaming line reader (`src/tools/fs/tools/read.ts`): never materializes a file bigger than the
  budget; `totalLines` is `null` when counting would defeat that.
- **Pagination contract:** truncated results carry `truncated: true` + a precomputed `nextOffset`,
  so the exact continuation call (`read({ path, offset: nextOffset })`) is always handed to the
  model. Truncation is never a dead end.

### write

Whole-file create/overwrite. `{ path, content }`

- Parent directories auto-created; unconditional overwrite; no read-before-write gate.
- **2 MiB cap**, and the error points at `edit` instead — errors are coaching, not verdicts.
- Preserves an existing file's mode (executables keep `+x`); runs under a per-file lock so a
  concurrent `edit`'s read-modify-write can't interleave.
- Usage policy ("new files or complete rewrites only") lives in the system prompt, not the schema.

### edit

Batch exact-match replacement. `{ path, edits: [{ oldText, newText }] }`

- Every `oldText` must match a **unique, non-overlapping** region of the _original_ file (edits are
  not applied incrementally). No `replace_all`, no occurrence index — uniqueness or an error that
  asks for more context.
- Matching ladder (`src/tools/fs/edit-diff.ts`): BOM strip/restore, CRLF normalize/restore, exact
  `indexOf` first, fuzzy fallback for whitespace/smart-quote drift.
- 2 MiB cap (fuzzy matching wants the whole buffer) → error points at `write`.
- Tolerates quirky models: `edits` as a JSON string, or legacy root-level `oldText`/`newText`.
- Returns diff/patch/`firstChangedLine` for UI/logs; the model needs only the confirmation.

### bash _(renamed from `exec`)_

Run a shell command in the workspace.
`{ command, cwd?, backend?, timeout? (seconds; no default; on expiry SIGTERM + exitCode 124, the GNU timeout(1) convention) }`

- **Why the rename:** aligns with pi and Claude Code. Models have orders of magnitude more training
  data on a tool named `bash`; a bespoke `exec` buys nothing but drift.
- **Backend selection** stays: `container` (default) = full Linux, public network, `gh`/`git`
  pre-authenticated, `npm`/`node`/`curl`/`wrangler` — use for anything touching GitHub, the network,
  or a real binary. `shell` = just-bash in a Dynamic Worker — cold-start fast, text tooling only
  (cat/grep/sed/awk/jq), **no binaries, no network**. Per-backend capability blurbs are rendered
  into the `backend` enum's schema description from the configured backends, so guidance can't
  drift from what's actually wired up.
- **Exit code is data, not an exception:** every call returns `{ exitCode, stdout, stderr }`, so
  failed commands surface their output without error-path gymnastics.
- **Truncation:** 32 KB per stream, head+tail split (first few KB + the tail) with an explicit
  `[… N bytes omitted …]` marker — build banners at the head, the error you need at the tail.
- **Redirect rule (non-negotiable):** noisy commands (installs, builds, test suites) must redirect
  to a container-local file and `tail` it — `… > /tmp/x.log 2>&1; tail -30 /tmp/x.log`. Unbounded
  output through the session can OOM the DO irrecoverably. Mandated in the tool description and
  every skill.
- `ls`, `find`, `grep -rn`, `rm`, `cat` all happen here.

## What we deliberately do NOT expose

Think merges its workspace tools unconditionally; we suppress them at two levels:

- `workspaceBash = false` drops Think's built-in just-bash tool (ours replaces it, with backends).
- `beforeTurn` returns `activeTools: ["read", "write", "edit", "bash"]` — the AI SDK filters
  **before** building the provider request, so inactive tools' name+description+schema never reach
  the model at all (not merely "uncallable").

What that removes, and why:

- **`list` / `find` / `grep` / `delete`** (~633 tokens/call combined) duplicate bash one-liners.
  Think's `grep` reads through the DO VFS with a 1 MB-per-file cap and a 200-match ceiling —
  container `grep`/`rg` is strictly more capable. `delete` was our only dedicated destructive tool
  (always `force: true`); as `rm` in a bash transcript it is at least legible.
- **Two-of-everything ambiguity**: with 8 tools the model had two greps and two ways to list; every
  redundant tool is both token rent and a wrong-choice opportunity.
- Same shape as pi's default: exactly read/write/edit/bash (~520 tokens there), with the system
  prompt saying "Use bash for file operations like ls, rg, find". No todo tool, no sub-agents, no
  delete tool — anything expressible as a shell command or a file does not get a tool.

## Lineage

- **Implementations:** Aron's hackspace fs-tools (`src/tools/fs/`) — streaming paged reads,
  per-file locks, mode preservation, the BOM/CRLF/fuzzy edit ladder — plus its exec skeleton.
- **Conventions:** pi's coding-agent — the four-tool default, actionable truncation notices,
  limits interpolated into descriptions, errors crafted as the model's next input.
- **Naming:** Claude Code — `read` / `write` / `edit` / `bash`.

Where we improve on the starting point:

1. `exec` → `bash` (training-data alignment) while keeping the `backend` param neither pi nor
   Claude Code has — one tool spans two isolation tiers.
2. bash gains a `timeout` param (seconds, none by default, stated in the schema — pi's convention)
   and head+tail truncation, replacing the old head-only cut that threw away exactly the part of
   build output that matters.
3. Exit code as a first-class structured field on every call (pi smuggles failure output through
   the error message; ours is uniform for success and failure).
4. read's precomputed `nextOffset` — pi's "never a bare [truncated]" rule, in structured form.
5. The bash description sheds the backend guidance duplicated in the system prompt: it was ~564
   tokens, a third of the old surface, saying things the prompt already said.
6. Four fewer tools than we shipped with, excluded from the provider request entirely.

## Adding a fifth tool

A new tool must clear **all four** bars:

1. **Not a bash one-liner or a file convention.** Todos are a TODO.md; plans are files; deletion
   is `rm`.
2. **Adds model-facing structure bash can't give:** pagination, exact-match semantics, typed
   truncation with continuation hints, or a hard safety boundary.
3. **Pays its context rent.** Every definition costs ~100–600 tokens on _every_ call, forever.
   It must save more than it costs, measured, not vibes.
4. **No overlap** with an existing tool's job — one way to read, one way to search, one way to run.

Nothing has cleared it yet. Plausible future candidates: a channel-output tool (mom's `attach`
pattern, ~124 tokens) if results ever need to leave the workspace; the read-only `grep`/`find`/`ls`
trio _only_ for a mode where bash is disabled entirely.
