# AI SDK v6 → v7 Migration Report

**Date:** 2026-07-09  
**Branch / worktree:** `fix/jul9-ai-sdk-v7` at `/Users/cjols/Code/agents/fix/jul9-ai-sdk-v7`  
**Base:** `rethink` (`f1b64cc5`)  
**Scope:** Minimal mechanical port of the Agents monorepo from AI SDK v6 to v7. No PR opened.

> Note: this monorepo root _is_ the rethink tree (packages live at `packages/*`), so this report is at the worktree root rather than a nested `rethink/` directory.

## Version map

| Package             | Before                 | After                        |
| ------------------- | ---------------------- | ---------------------------- |
| `ai`                | `^6.0.x`               | `^7.0.0` (resolved `7.0.18`) |
| `@ai-sdk/react`     | `^3.0.204`             | `^4.0.0` (resolved `4.0.19`) |
| `@ai-sdk/openai`    | `^3.0.70`              | `^4.0.0` (resolved `4.0.9`)  |
| `@ai-sdk/anthropic` | `^3.0.83`              | `^4.0.0` (resolved `4.0.10`) |
| `@ai-sdk/google`    | `^3.0.81`              | `^4.0.0` (resolved `4.0.10`) |
| `@ai-sdk/provider`  | `^3.0.10` (where used) | `^4.0.0`                     |

Updated **54** `package.json` files (root, packages, examples, experimental, think-starters, agent-think, wip) plus `pnpm-lock.yaml`.

## Research sources

- [Migrate AI SDK 6.x to 7.0](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)
- GitHub release notes for `ai@7.0.0` on `vercel/ai`
- Installed package types in `node_modules/ai@7.0.18`

## Breaking changes encountered and resolution

### 1. Package major bumps (mechanical)

**Change:** `ai@7` + `@ai-sdk/*@4`  
**Resolution:** Bulk version bumps + `pnpm install`.  
**Status:** Done.

### 2. `stepCountIs` → `isStepCount`

**Change:** Stop-condition helper renamed (`stepCountIs` remains a deprecated alias).  
**Resolution:** Renamed imports/usages in Think, voice tests, ai-chat e2e, codemode e2e, examples.  
**Status:** Done.

### 3. `system` → `instructions` (AI SDK call sites only)

**Change:** `streamText` / `generateText` top-level prompt option renamed.  
**Resolution:**

- Think’s internal `streamText({ instructions: turnSystem })` updated.
- `TurnConfig.instructions` is the preferred public name; deprecated `TurnConfig.system` remains as an alias.
- `StepConfig.instructions` is the preferred per-step override name; AI SDK/Think still accept deprecated `StepConfig.system`.
- `TurnContext.system` and extension snapshots remain `system` because they describe Think’s assembled prompt context rather than a direct AI SDK call option.

**Status:** Done for AI SDK call sites and aliasable Think config surfaces.

### 4. Lifecycle callback renames

| v6                                   | v7                                 | Status                                                                                   |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `onStepFinish`                       | `onStepEnd` (alias kept)           | Think exposes preferred `onStepEnd`; deprecated `onStepFinish` remains as subclass alias |
| `onFinish`                           | `onEnd`                            | Used where telemetry integrations needed it                                              |
| `experimental_onToolCallFinish`      | `onToolExecutionEnd`               | Think wired to `onToolExecutionEnd`                                                      |
| `StreamTextOnStepFinishCallback`     | `GenerateTextOnStepFinishCallback` | Import updated                                                                           |
| `StreamTextOnFinishCallback`         | `GenerateTextOnFinishCallback`     | ai-chat import updated                                                                   |
| `StreamTextOnToolCallFinishCallback` | `OnToolExecutionEndCallback`       | Import updated                                                                           |

**Status:** Done.

### 5. `onToolExecutionEnd` event shape change (behavioral + types)

**Change (important):** The tool-finish event is no longer `{ success, output, error, durationMs, stepNumber }`. In v7:

- `durationMs` → `toolExecutionMs`
- success/error/output → `toolOutput` discriminated union:
  - `{ type: 'tool-result', output }`
  - `{ type: 'tool-error', error }`
- `stepNumber` is **not** present on this event

**Resolution:** Think’s `onToolExecutionEnd` adapter exposes v7-style `toolOutput` and `toolExecutionMs`, while keeping deprecated `success` / `output` / `error` / `durationMs` aliases. `stepNumber` remains present as `undefined` because v7 no longer supplies it.

**Status:** Done. Covered by Think hooks tests (all 894 workers tests pass).

### 6. Telemetry

| v6                            | v7                                        | Resolution                                                                         |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `experimental_telemetry`      | `telemetry` (alias kept)                  | Think exposes `telemetry`; deprecated `experimental_telemetry` still aliases to it |
| `TelemetryOptions.metadata`   | **removed**                               | Test integration no longer sets/reads `metadata`                                   |
| OpenTelemetry built into `ai` | moved to `@ai-sdk/otel`                   | **Not integrated** (no prior OTEL registration in this repo path)                  |
| Telemetry opt-in per call     | opt-out once an integration is registered | No global registration added                                                       |

**Status:** Mechanical rename done. OTEL package not added (no prior usage to migrate).

### 7. Usage token fields

**Change:** `usage.reasoningTokens` / `usage.cachedInputTokens` removed; use `outputTokenDetails.reasoningTokens` / `inputTokenDetails.cacheReadTokens`.  
**Resolution:** Extension step-finish snapshot reads both shapes with fallbacks.  
**Status:** Done.

### 8. `ToolCallOptions` → `ToolExecutionOptions`

**Change:** Type removed; replacement is generic `ToolExecutionOptions<CONTEXT>`.  
**Resolution:**

- Tests cast `{} as ToolExecutionOptions<unknown>`
- Tool `execute` option objects now include `context: {}` where required

**Status:** Done for compile/tests.

### 9. Flexible tool `description`

**Change:** `Tool.description` may be `string | ((options) => string)`.  
**Resolution:** Normalize to string (or drop function form) in:

- `packages/agents/src/chat/client-tools.ts`
- `packages/agents/src/browser/tanstack-ai.ts`
- `packages/codemode/src/connectors/toolset.ts`

**Status:** Done.

### 10. Portable DTS for tools built with `tool()`

**Change:** Inferred return types of `createReadTool` etc. pull non-portable types from `@ai-sdk/provider-utils@5` / `@ai-sdk/provider@4`.  
**Resolution:** Explicit `: Tool` / `: ToolSet` return annotations on workspace/extension tool factories.  
**Status:** Done (`@cloudflare/think` builds).

### 11. ESM-only / Node ≥ 22

**Change:** AI SDK packages are ESM-only; Node 22+ required.  
**Resolution:** Monorepo already `"type": "module"`; local Node is v24.15.0. No engines field change made.  
**Status:** N/A / already compatible.

### 12. `fullStream` → `stream`

**Change:** `StreamTextResult.fullStream` renamed to `stream` (alias kept).  
**Resolution:** Voice package source/docs/tests now use `result.stream` terminology. Historical changelog entries still mention `fullStream`.  
**Status:** Done.

### 13. `toUIMessageStream` result methods deprecated

**Change:** Prefer top-level `toUIMessageStream({ stream: result.stream, ... })`.  
**Resolution:** Think's AI SDK boundary now uses top-level `toUIMessageStream({ stream: result.stream, ... })`. Package-local `StreamableResult.toUIMessageStream()` remains as Think's abstraction/test seam.  
**Status:** Done.

### 14. System messages in `messages` rejected by default

**Change:** `{ role: 'system' }` inside `messages`/`prompt` requires `allowSystemInMessages: true`.  
**Resolution:** Not changed. Think already puts system text in the top-level instructions/system path.  
**Status:** Monitor if any consumer feeds system-role messages into `streamText` messages arrays.

### 15. Multi-step result accumulation

**Change:** Top-level `usage`, `toolCalls`, `content`, etc. now accumulate across steps; final-step-only via `finalStep`.  
**Resolution:** No code changes. Call sites that assumed final-step-only semantics may need audit.  
**Status:** TODO / document for follow-up.

### 16. Image / media content parts

**Change:** Prefer `file` over legacy `image` / `image-data` / `media` / `file-data` content parts. AI SDK v7 docs show multimodal tool results as `{ type: "file", mediaType, data: { type: "data", data } }`.  
**Resolution:** Think workspace file replay now emits `file` parts for images and other inline files. Tests updated.  
**Status:** Done for known `image-data` / `file-data` AI SDK tool-result output paths.

### 17. `workers-ai-provider` peer range

**Change:** `workers-ai-provider@4.0.0` declares peers on `ai@^7` and `@ai-sdk/*@^4`.

**Resolution:** Updated AI SDK v7 applications to `workers-ai-provider@^4.0.0`. The AI SDK v6 compatibility matrix repins Think to provider v3.

**Status:** Done.

## Architectural decisions / TODOs left open

1. **Some Think context vocabulary still uses `system`.** `TurnConfig`/`StepConfig` now prefer `instructions` with deprecated `system` aliases, but `TurnContext.system` and extension snapshots still use `system` for the assembled prompt context.
2. **`onToolExecutionEnd` no longer provides `stepNumber`.** Think sets `stepNumber: undefined` in `ToolCallResultContext`. If callers relied on it, restore via step tracking in Think (not guessed here).
3. **Do not globally register `@ai-sdk/otel`** until product wants default-on telemetry.
4. **`allowSystemInMessages` policy** if any persisted transcripts embed system roles.
5. **Audit multi-step result consumers** for final-step-only assumptions (`usage`, `toolCalls`, `files`, …).
6. **Audit remaining package-local `toUIMessageStream` abstractions** before next AI SDK major; Think's direct AI SDK result call was migrated to the stateless helper.
7. **Codemod `npx @ai-sdk/codemod v7`** was attempted but timed out; renames applied manually / partially by an interrupted run, then cleaned up.

## Verification

### Builds

- `agents`, `@cloudflare/ai-chat`, `@cloudflare/codemode`, `@cloudflare/shell`, `@cloudflare/think`, `@cloudflare/rethink`, `@cloudflare/voice` — **build OK** (after portable return types).

### Tests (package workers / unit)

| Package                            | Result                             |
| ---------------------------------- | ---------------------------------- |
| `@cloudflare/think` `test:workers` | **894/894 passed**                 |
| `agents` `test`                    | **2230/2230 passed**               |
| `@cloudflare/codemode` `test`      | **all passed** (unit + e2e suites) |
| `@cloudflare/ai-chat` `test`       | **728/728 passed**                 |

### Typecheck

- `pnpm run typecheck` still reports residual errors, primarily:
  - `create-think` not built (`packages/think/src/cli/*`)
  - Unbuilt example/provider packages (`@cloudflare/worker-bundler`, voice providers, etc.)
- **No remaining AI-SDK-specific type errors under `packages/` source** (excluding unbuilt create-think CLI).

## How to resume

```bash
cd /Users/cjols/Code/agents/fix/jul9-ai-sdk-v7
pnpm install
pnpm --filter agents --filter @cloudflare/think --filter @cloudflare/ai-chat --filter @cloudflare/codemode run build
pnpm --filter @cloudflare/think run test:workers
pnpm run typecheck
```

No PR was opened, per task instructions.
