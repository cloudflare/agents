# create-think

Scaffold a new [Cloudflare Think](https://www.npmjs.com/package/@cloudflare/think)
agent in seconds.

```sh
npm create think@latest
# or
pnpm create think
yarn create think
bun create think
```

## Usage

```sh
npm create think@latest [directory] -- [options]
```

| Option           | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `--template, -t` | Starter template (omit to choose interactively)       |
| `--name`         | Package and Worker name                               |
| `--ref`          | Git ref to fetch templates from                       |
| `--yes, -y`      | Skip prompts and use defaults (`basic`, fresh folder) |
| `--no-install`   | Skip `npm install`                                    |
| `--dry-run`      | Print what would be created without writing           |

## Templates

| Template             | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `basic`              | Minimal Think chat agent with a small React chat UI        |
| `personal-assistant` | Persistent memory (`configureSession`) and scheduled tasks |
| `coding-agent`       | Workspace file tools and a coding skill                    |
| `customer-support`   | Custom tools and an escalation skill                       |
| `webhook-agent`      | Inbound webhooks via durable, idempotent submissions       |
| `business-workflow`  | Human-in-the-loop approval gates and a scheduled digest    |

```sh
npm create think@latest my-agent -- --template coding-agent
```

## What you get

Each starter is a complete, deployable Cloudflare Workers app using the Think
framework: a streaming chat agent, persistent history, resumable streams, and
built-in workspace file tools, wired up with Vite and Wrangler. The project is
initialized as a git repository (skipped if you scaffold inside an existing one)
and ships with Oxlint + Oxfmt configured behind a `check` script.

```sh
cd my-agent
npm run dev      # local dev
npm run check    # format check + lint + typecheck
npm run deploy   # deploy to Cloudflare
```
