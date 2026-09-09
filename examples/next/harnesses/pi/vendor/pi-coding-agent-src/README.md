# Vendored pi extension runtime

Source: [earendil-works/pi](https://github.com/earendil-works/pi) @ `c4b0e35a`,
`packages/coding-agent/src/` — MIT, Copyright (c) 2025 Mario Zechner. The exact
commit, the package version the vendored tarballs in `../pi-dev` line up with,
and a sha256 of every generated file are in [MANIFEST.json](./MANIFEST.json).

## Why this exists

`@earendil-works/pi-coding-agent` cannot be bundled for workerd at any entry
point: its module graph reaches `child_process`, `vm`, `net`, `undici`, `jiti`
and a native TUI. But pi's *extension runtime* is portable — `ExtensionRunner`
touches nothing Node-specific, and the factory half of the extension loader is
pure. Vendoring those few files lets the Cloudflare pi harness expose pi's real
`ExtensionAPI` instead of a hand-rolled lookalike, and lets extensions written
for pi run unchanged.

The trick that keeps the copies verbatim: `agents/tsconfig` uses
`moduleResolution: bundler` with `allowImportingTsExtensions` and
`verbatimModuleSyntax`, so upstream's relative `./foo.ts` specifiers resolve as
written and `import type` is erased at build time. The tree therefore mirrors
upstream's directory layout, and every module upstream imports but we do not
want is a hand-written stub sitting at the same relative path.

## What is what

**Verbatim from upstream** (a three-line provenance banner is prepended; the
rest is byte-for-byte):

- `core/extensions/types.ts`
- `core/extensions/runner.ts`
- `core/extensions/wrapper.ts`
- `core/tools/tool-definition-wrapper.ts`
- `core/messages.ts`
- `core/diagnostics.ts`
- `core/source-info.ts`
- `core/slash-commands.ts`

**Upstream, patched** (patch files in `patches/`, applied by the vendor script):

- `core/extensions/loader.ts` — `patches/0001-loader-inline-only.patch`.
  Keeps `createExtensionRuntime`, `createExtensionAPI`, `createExtension`,
  `initializeExtension` and `loadExtensionFromFactory`. Drops jiti, `node:fs`,
  `node:path`, `VIRTUAL_MODULES`, the jiti alias table, the extension cache and
  all directory discovery. `pi.exec` no longer spawns a process: an optional
  `shell: Shell` parameter (`{ exec(command, args, options?) }`) is threaded
  through `createExtensionAPI` → `initializeExtension` →
  `loadExtensionFromFactory` as the last argument, defaulting to one that throws
  `"exec is not available"`. `time()` instrumentation is dropped and
  `path.dirname` becomes a local helper.
- `core/prompt-templates.ts` — `patches/0002-prompt-templates-pure.patch`.
  Keeps `PromptTemplate`, `parseCommandArgs`, `substituteArgs` and
  `expandPromptTemplate`; drops the `fs`/`path` loaders (`loadPromptTemplates`
  and friends). The host supplies templates.

**Stubs** — not upstream code, written by us, each carrying the banner
`// STUB — not upstream pi code`:

| Path | What it stands in for |
| --- | --- |
| `config.ts` | `APP_NAME`, `CONFIG_DIR_NAME`, `getAgentDir()` |
| `core/event-bus.ts` | upstream's 33-line `EventEmitter` bus, reimplemented over a `Map` |
| `core/exec.ts` | `ExecOptions` / `ExecResult` types only |
| `core/session-manager.ts` | entry interfaces copied verbatim + `ReadonlySessionManager` (the 14 methods upstream `Pick`s); `SessionManager` aliases it |
| `core/model-registry.ts` | 3-method interface (`registerProvider` ×2 overloads, `unregisterProvider`) |
| `core/model-resolver.ts` | `ScopedModel` |
| `core/system-prompt.ts` | `BuildSystemPromptOptions` |
| `core/skills.ts` | `Skill` |
| `core/compaction/index.ts` | `CompactionPreparation` re-exported from pi-agent-core + `CompactionResult` |
| `core/keybindings.ts` | `KeybindingsConfig` / `KeybindingsManager` / `AppKeybinding` |
| `core/footer-data-provider.ts` | `ReadonlyFooterDataProvider` |
| `core/bash-executor.ts` | `BashResult` |
| `core/package-manager.ts` | `PathMetadata` |
| `core/tools/{index,bash,edit}.ts` | tool input/detail types the extension events name |
| `modes/interactive/theme/theme.ts` | a real, colourless `theme` value object + `Theme` type |
| `_stubs/pi-tui.d.ts` | `@earendil-works/pi-tui`, mapped in via tsconfig `paths` |

Stub shapes follow upstream wherever upstream has a shape to follow. Where a
type is derived from a typebox schema upstream (the tool inputs) or comes from a
module that is not vendored (`ProviderConfigInput`), the stub restates the
closest equivalent; those are noted in the file.

## Regenerating

```sh
pnpm vendor:pi          # rewrite the upstream + patched files and MANIFEST.json
pnpm vendor:pi:check    # regenerate into a temp dir and fail on drift (CI)
```

The script is [`scripts/vendor-pi-coding-agent.ts`](../../../../../scripts/vendor-pi-coding-agent.ts).
It reads from `$PI_REPO`, else `~/Documents/Github/pi-mono`, else a shallow
clone of the pinned commit.

To bump the pin: change `UPSTREAM_COMMIT` in the script, run `pnpm vendor:pi`,
refresh the patches if they no longer apply (edit the generated file, then
`git diff --no-index --no-prefix a/<path> b/<path>` against a pristine run), and
typecheck the example. A new *value* import in an upstream file is the thing to
watch for: it silently turns a type-only stub into a runtime dependency.

Do not edit the generated files by hand — `vendor:pi:check` will fail. Edit the
patches, or the stubs.

## Lint, format, tests

The whole directory is in `ignorePatterns` in the repo's `.oxfmtrc.json` and
`.oxlintrc.json`: upstream's style is not ours, and reformatting would make
every future re-vendor a conflict. It *is* in the example's tsconfig `include`,
so it is typechecked.
