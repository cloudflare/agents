# Contributing

We are not accepting external pull requests at the moment. The SDK is changing quickly, and we want to keep its surface manageable. We would still like to hear from you:

- **Bug reports and feature requests:** [open an issue](https://github.com/cloudflare/agents/issues).
- **Questions and ideas:** [start a discussion](https://github.com/cloudflare/agents/discussions).

The rest of this page is for people working on the repository.

## Repository structure

| Directory                       | What is in it                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| [`packages/`](packages)         | Published npm packages. [`packages/agents/`](packages/agents) is the SDK.             |
| [`examples/`](examples)         | Self-contained example apps. [`examples/next/`](examples/next) holds the newest ones. |
| [`openai-sdk/`](openai-sdk)     | Examples using the OpenAI Agents SDK                                                  |
| [`guides/`](guides)             | Pattern tutorials with narrative READMEs                                              |
| [`experimental/`](experimental) | Work in progress. Not published, and no stability guarantees.                         |
| [`docs/`](docs)                 | Markdown docs, synced by hand to developers.cloudflare.com                            |
| [`design/`](design)             | Architecture and design decision records                                              |
| [`site/`](site)                 | agents.cloudflare.com                                                                 |
| [`scripts/`](scripts)           | Repository tooling                                                                    |

[`AGENTS.md`](AGENTS.md), and the `AGENTS.md` files in the directories above, have deeper guidance for each part of the repository.

## Development

Node 24 or later is required. The repository uses pnpm workspaces, with [Nx](https://nx.dev) for task orchestration, caching and affected detection.

```sh
pnpm install                   # install all workspaces
pnpm run build                 # build all packages (cached, in dependency order)
pnpm run check                 # sherif, export and README checks, oxfmt, oxlint, typecheck
pnpm run test                  # vitest, including vitest-pool-workers in the Workers runtime
pnpm run test:react            # Playwright-based React hook tests
pnpm exec nx affected -t build # build only what changed
pnpm exec nx affected -t test  # test only what changed
```

## Changesets

Changes to `packages/` that affect the public API or fix a bug need a changeset:

```sh
pnpm exec changeset
```

Examples, guides and sites do not need one.

## The README

The root `README.md` is also the README of the `agents` package on npm. npm publishes `packages/agents/README.md`, which is an exact copy. Edit the root file, then update the copy:

```sh
pnpm run check:readme --write
```

`pnpm run check` fails if the copy is out of date, or if the README has a relative link, which would break on npmjs.com.
