# Next: an agent CLI in a Container

An early-access, server-only example of `ContainerHarness` from
`agents/harness/container`: Claude Code or Codex runs in a Cloudflare
Container, and a plain Durable Object drives it with the same interface as
`PiHarness`. There is no Dockerfile, and no credentials enter the container.

```ts
import { ContainerHarness, claudeCode, codex } from "agents/harness/container";

// Adds the credentials outside the container; export it from the main module.
export { ContainerEgress } from "agents/harness/container";

abstract class CodingAgent extends DurableObject<Env> {
  abstract agent(): ContainerAgent;

  readonly harness = new ContainerHarness({
    container: this.ctx.container,
    egress: this.ctx.exports.ContainerEgress,
    agent: this.agent()
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}

export class ClaudeCodeAgent extends CodingAgent {
  agent() {
    return claudeCode({
      baseUrl: `${this.env.AI_GATEWAY_URL}/anthropic`,
      apiKey: this.env.AI_GATEWAY_TOKEN
    });
  }
}

export class CodexAgent extends CodingAgent {
  agent() {
    return codex({
      baseUrl: `${this.env.AI_GATEWAY_URL}/openai`,
      apiKey: this.env.AI_GATEWAY_TOKEN
    });
  }
}

// anywhere in either object:
const { text } = await this.harness.prompt("Add a test for parse()");
```

The two agents differ only in the preset. Leave out `baseUrl` to call the
provider directly with its own key, and add `headers` for anything else a
request needs (gateway metadata, or `cf-aig-authorization` for a BYOK
gateway).

```jsonc
// wrangler.jsonc
"containers": [
  { "class_name": "ClaudeCodeAgent", "scheduling_policy": "durable_object" },
  { "class_name": "CodexAgent", "scheduling_policy": "durable_object" }
]
```

## What happens

- **First start.** The harness starts `cloudflare/debian-trixie`, uses
  `exec()` to create an unprivileged `agent` user and install the CLI
  (`npm install -g @anthropic-ai/claude-code`), writes its bundled daemon
  into the container, and snapshots the filesystem. Later starts restore the
  snapshot and are ready in a few seconds. Changing the preset (a new CLI
  version, extra `setup` steps) sets up afresh.
- **Each turn** is one CLI process run as `agent`: `claude -p
--output-format stream-json` or `codex exec --json`. The daemon turns its
  output into the harness's messages and events, and mirrors the CLI's
  session files (`~/.claude/projects`, `~/.codex/sessions`) to the object as
  the turn runs.
- **Credentials.** The CLI is pointed at a placeholder host
  (`http://anthropic.harness.internal`) with a placeholder key. The harness
  intercepts that host with `ctx.container.interceptOutboundHttp()`, and
  `ContainerEgress`, running in your Worker, swaps in the real credentials
  and forwards to `baseUrl`. `env` in the container shows only the
  placeholder.
- **Recovery.** Five minutes after the last prompt (`idleTimeoutMs`) the
  harness snapshots the container, workspace included, and stops it. The
  next prompt starts a new one from that snapshot and the CLI resumes its
  own session. If the container dies mid-run, that run settles `unanswered`
  with `container_lost`, the next container starts from the last snapshot
  (workspace edits since then are lost), and the session continues from
  the CLI's session files, which are saved as each turn runs. If the object is evicted
  mid-run, the container keeps working; the object reattaches and replays
  what it missed.

## Customise the CLI

Everything goes in `setup`: steps run once, on the first start, and their
result is kept in the snapshot. A step with `user: "agent"` runs as the user
the CLI runs as, in its home, and every session's home starts as a copy of
that home. So installing your plugins and mods, skills, `CLAUDE.md` or
`~/.claude/settings.json` works as it does on your laptop:

```ts
claudeCode({
  baseUrl: `${this.env.AI_GATEWAY_URL}/anthropic`,
  apiKey: this.env.AI_GATEWAY_TOKEN,
  setup: [
    // your own Claude Code build, over the pinned release (as root)
    {
      name: "my fork",
      command: ["npm", "install", "-g", "github:you/claude-code#mods"]
    },
    // your plugins and mods, from your own marketplace (as the agent)
    {
      name: "my mods",
      user: "agent",
      command: [
        "sh",
        "-c",
        "claude plugin marketplace add you/my-mods && claude plugin install token-chart@my-mods"
      ]
    }
  ]
});
```

Changing `setup` takes effect when a container next starts: one that is
running when you deploy keeps its setup until it stops (idle, or
`harness.stop()`), and the next one sets up afresh. The workspace snapshot
is tied to the old setup, so the new container starts without it. A token a
step uses (to clone a private repository, say) stays in the snapshot, where
the agent can read it: prefer public sources or short-lived URLs.

## Another CLI

Build an image whose entrypoint serves the daemon with `cliAdapter`, and use
`containerAgent({ image: ctx.container.images.agent, adapter: "my-agent" })`:

```ts
import { cliAdapter, serveFromEnv } from "agents/harness/container/runtime";

await serveFromEnv(
  cliAdapter({
    id: "my-agent",
    stateDirs: [".my-agent/sessions"],
    command: (turn) => ({
      argv: [
        "my-agent",
        "--json",
        ...(turn.state.id ? ["--resume", turn.state.id] : [])
      ],
      stdin: turn.prompt
    }),
    parser: () => ({
      line: (text) => myAgentLine(JSON.parse(text)), // events, state, outcome
      end: ({ code }) => ({ status: "unanswered", reason: `exit ${code}` })
    })
  })
);
```

## Run

Containers need Docker locally. Set `AI_GATEWAY_URL` in `wrangler.jsonc` and
put an AI Gateway token in `.env` (see `.env.example`):

```sh
cp .env.example .env   # then fill in AI_GATEWAY_TOKEN
pnpm install
pnpm run dev
```

With [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
the gateway token is the only credential, and it never leaves the object.

Exercise the agent named `demo`, as Claude Code or as Codex: the routes are
the same.

```sh
B=http://localhost:8787/agents/claude-code-agent/demo   # or /agents/codex-agent/demo

# Prompt and wait for the answer.
curl -X POST $B/prompt -H "content-type: application/json" \
  -d '{"text": "Create hello.txt containing hi", "wait": true}'

# Or submit, watch events over SSE, and wait for one operation.
curl -X POST $B/prompt -H "content-type: application/json" -d '{"text": "ls"}'
curl -N $B/events
curl $B/operations/<operationId>

# Stop the container, then prompt again: a new container resumes the session.
curl -X POST $B/stop

curl $B/messages
curl $B/            # container, sessions, pending operations
```

Add `?session=<id>` to address a session other than the root; `POST
$B/sessions` creates one.

The routes have no authentication, to keep the example short. They drive an
agent that runs commands and spends model credit: put your own auth in front
of them before deploying anywhere public. The container can reach the
Internet (setup needs it); the credentials still never enter it.
