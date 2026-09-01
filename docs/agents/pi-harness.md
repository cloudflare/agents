# Pi harness capability

> **Experimental.** `agents/harness` currently pins a specific development
> revision of pi. Its API may change before pi publishes the completed durable
> harness.

`PiHarness` runs pi's durable `AgentHarness` inside a Lifecycle Durable Object.
It stores the pi Session in the object's SQLite database and uses Lifecycle jobs
to wake accepted operations after eviction.

## Install the capability

```ts
import { DurableObject } from "cloudflare:workers";
import {
  PiHarness,
  Type,
  type PiPromptResponse,
  type PiTool
} from "agents/harness";
import { Lifecycle } from "agents/lifecycle";
import { createWorkersAI } from "agents/providers/pi";

const parameters = Type.Object({ value: Type.Number() });

type ToolContext = {
  multiplier: number;
};

const multiply: PiTool<ToolContext, typeof parameters> = {
  name: "multiply",
  label: "Multiply",
  description: "Multiply a number.",
  parameters,
  replay: "safe",
  async execute(_id, input, onUpdate, toolContext) {
    const result = input.value * toolContext.multiplier;
    onUpdate(
      {
        content: [{ type: "text", text: `Working: ${result}` }],
        details: null
      },
      { checkpoint: true }
    );
    return {
      content: [{ type: "text", text: String(result) }],
      details: null
    };
  }
};

export class MathAgent extends DurableObject<Env> {
  private readonly runtime = createWorkersAI(this.env.AI);

  readonly harness = new PiHarness({
    ...this.runtime,
    toolContext: { multiplier: 2 },
    tools: () => [multiply]
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async chat(prompt: string): Promise<PiPromptResponse> {
    return this.harness.prompt(prompt);
  }
}
```

`createWorkersAI` adapts a Workers AI binding into the model registry and model
used by pi. It lives in `agents/providers/pi` so `agents/harness` remains
provider-independent.

## Run operations

`prompt()` waits for the operation and returns its outcome with display-ready
messages. Installing the harness with Lifecycle is enough; public methods start
the Lifecycle when needed.

```ts
const { status, operationId, messages } =
  await this.harness.prompt("Multiply 21 by two");
```

Use `getMessages()` to read the current display-ready transcript without
starting a new operation. `findEntries()` remains available when you need pi's
raw entries.

`submit()` returns after the Lifecycle wake has been persisted. Poll
`getResult()` using its operation ID:

```ts
const receipt = await this.harness.submit({
  kind: "prompt",
  prompt: "Multiply 21 by two"
});

const result = await this.harness.getResult(receipt.operationId);
```

`submit()` persists the Lifecycle wake before pi accepts the operation. A crash
between those steps therefore leaves a queued submission, rather than accepted
work with no future wake.

## Dynamic tools and hooks

Tool functions are not durable data. `tools` may be a callback, and `PiHarness`
resolves it before each drive pass owned by that operation. After an eviction or
deployment, recovery uses the new implementation registered under the stored
tool name.

Pi persists the effective arguments, invocation ID, replay policy, progress
checkpoint, and final result. If a restored tool is absent or no longer safe to
replay, pi settles the interrupted call as an error instead of running it again.

Use `configure` to register pi hooks after every isolate wake. Hooks are also
process-local. Side effects in a hook must use the stable operation or invocation
ID for idempotency.

## Durability boundary

Pi owns:

- transcript entries and branch tips;
- accepted operation state;
- provider intent and settlement;
- tool arguments, progress, replay memos, and final results;
- retry and cancellation state.

Lifecycle owns the durable wake job and physical Durable Object alarm. The
wrapper does not run pi inside `Tasks`, because that would give two runtimes
responsibility for replaying the same model and tool effects.
