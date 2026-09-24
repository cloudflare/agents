# OpenCode harness

This example runs `@opencode/sdk/workerd` inside a Durable Object through `agents/opencode` and `agents/driver`.

OpenCode owns its transcript, durable inbox, execution claim, restart attempts, model loop, and terminal records. The shared driver adds durable intake, alarm wake-up, cancellation routing, and operation stream settlement. OpenCode's durable session log repairs semantic output after restart, while transcript snapshots repair missing live-only deltas.

The workerd profile has no local filesystem, process, shell, or terminal execution plane. The example denies `bash` and `edit`. A production coding agent should connect those tools to Sandbox or Containers through durable tool runs.

## Run locally

```sh
pnpm install
pnpm run start
```

## Composition

```ts
import { OpenCodeHarness } from "agents/opencode";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { WebSockets } from "agents/websockets";

readonly streams = new Streams();
readonly harness = new OpenCodeHarness({
  streams: this.streams,
  agent: "build",
  config: {
    model: "anthropic/claude-sonnet-4-5",
    permission: { bash: "deny", edit: "deny" }
  }
});
readonly webSockets = new WebSockets(this.harness.webSockets());
readonly lifecycle = Lifecycle.install(this)
  .use(this.streams)
  .use(this.harness.driver)
  .use(this.webSockets)
  .use(this.harness);
```

The first driver integration supports prompt turns with a stable native message identifier. Commands, skills, and exact resumption of an interrupted foreground tool need native operation correlation or a deferred-tool recovery hook before they can make the same durability guarantee.
