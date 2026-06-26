# create-think

## 0.1.1

### Patch Changes

- [#1817](https://github.com/cloudflare/agents/pull/1817) [`7f367d8`](https://github.com/cloudflare/agents/commit/7f367d88eb988d5f0285d4922d1091c7f69361a3) Thanks [@threepointone](https://github.com/threepointone)! - `create-think` now prompts for a starter template when `--template` is omitted (and falls back to `basic` when stdin is non-interactive). `npm create think` and `think init` initialize a git repository — skipping cleanly when the target is already inside one — and scaffold projects with Oxlint/Oxfmt config plus a `check` script. Removes the unused declarative `agent()` framework helper and the identity helpers (`defineMessengers`, `defineScheduledTasks`, `defineChannels`) in favor of class-based agents and typed object returns.

## 0.1.0

### Minor Changes

- [#1770](https://github.com/cloudflare/agents/pull/1770) [`718634f`](https://github.com/cloudflare/agents/commit/718634f9664a14fd5d666c63964e9723e073911f) Thanks [@threepointone](https://github.com/threepointone)! - Add `webhook-agent` and `business-workflow` starter templates.

  `webhook-agent` scaffolds an agent fed by inbound webhooks through durable,
  idempotent submissions (a custom `src/server.ts` entry + `submitMessages`).
  `business-workflow` scaffolds a back-office operations agent with
  human-in-the-loop approval gates (`needsApproval` + an approval UI) and a
  scheduled digest. Every starter now also ships a `start.md` you can paste into an
  AI coding agent for guided setup.

## 0.0.4

### Patch Changes

- [`7bcd1b1`](https://github.com/cloudflare/agents/commit/7bcd1b1a471ec887b781662747a44bf105593efc) Thanks [@threepointone](https://github.com/threepointone)! - Bundle runtime dependencies (`tiged`, `yargs`, and their transitive deps) into the published output. `create-think` now ships as a fully self-contained package, so `npm create think` is a single download that runs without resolving or installing any transitive dependencies.

## 0.0.3

### Patch Changes

- [#1699](https://github.com/cloudflare/agents/pull/1699) [`b1b8268`](https://github.com/cloudflare/agents/commit/b1b8268e541a29201f2edfaad8e105cda8bc131f) Thanks [@threepointone](https://github.com/threepointone)! - Decouple `create-think` from `@cloudflare/think` for fast project starts.

  `create-think` is now fully standalone — it owns the starter-template scaffolding logic and depends only on `tiged` + `yargs`, so `npm create think` no longer installs the entire framework just to copy a template.

  `think init` now has two modes:
  - **New project** — when `--template` is given, or when run outside an existing npm project, it delegates to `create-think` to fetch a complete starter template.
  - **Augment in place** — when run inside an existing npm project with no `--template`, it adds Think framework files (agent, Vite/Wrangler config, generated types) and merges dependencies into the current project.

  The internal `@cloudflare/think/cli` export has been removed (its scaffolding logic now lives in `create-think`).

## 0.0.2

### Patch Changes

- [#1695](https://github.com/cloudflare/agents/pull/1695) [`b545e86`](https://github.com/cloudflare/agents/commit/b545e867d8ee559de9aff7b795dfdf7ef90d2185) Thanks [@threepointone](https://github.com/threepointone)! - New package. Scaffold a Cloudflare Think agent with `npm create think` (also `pnpm`/`yarn`/`bun create think`). Ships four starters — `basic`, `personal-assistant`, `coding-agent`, and `customer-support` — each a complete, deployable Workers app.

- Updated dependencies [[`124a47a`](https://github.com/cloudflare/agents/commit/124a47a91c8a9db0bcf08ab931a5dd99a2fac663), [`b545e86`](https://github.com/cloudflare/agents/commit/b545e867d8ee559de9aff7b795dfdf7ef90d2185)]:
  - @cloudflare/think@0.8.6
