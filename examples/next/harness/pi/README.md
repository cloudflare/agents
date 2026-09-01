# Pi harness playground

A playable pi `AgentHarness` hosted as an `agents/lifecycle` capability. Each
browser session addresses one Durable Object with its own durable transcript,
operation state, and key-value memory.

## Run locally

```bash
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI usage.
It needs no API key.

## What to try

- `Roll four 12-sided dice and total them.`
- `Use the calculator to multiply 47 by 19.`
- `Remember that my favourite launch snack is stroopwafels.`
- `What did I tell you my favourite launch snack was?`
- `List everything you remember.`
- `Use a tool to tell me the current UTC time.`

The model can call `calculate`, `roll_dice`, `remember`, `recall`,
`list_memories`, and `current_time`. Tool calls and results render inline with
the transcript. Use **New session** to start with a new Durable Object.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  private readonly runtime = createWorkersAI(this.env.AI);

  readonly harness = new PiHarness({
    ...this.runtime,
    tools: () => tools,
    toolContext: { storage: this.ctx.storage }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async chat(prompt: string) {
    return this.harness.prompt(prompt);
  }
}
```

Import `PiHarness` from `agents/harness` and `createWorkersAI` from
`agents/providers/pi`. `prompt()` returns the durable operation outcome and the
updated display-ready messages. `PiHarness` stores pi's Session in Durable
Object SQLite; Lifecycle supplies durable wakes after eviction.
