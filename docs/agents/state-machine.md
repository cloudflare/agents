# State machines

> **Experimental.** Everything exported from `agents/state-machine` may
> change between releases while the durable execution surface stabilizes.

`agents/state-machine` is the durable state-machine engine that
[Tasks](./tasks.md) is built on: one `StateMachine` capability that owns
named machine definitions — `{ initial, phases, onCancel?, migrate? }` —
and drives each run's checkpoint through its phase handlers, with a
mailbox, durable asks, children, engine-owned streams, and the abort
protocol described on the Tasks page.

Use it directly when a Lifecycle Object runs actors and never needs the
Workflows-shaped job form. `Tasks` **extends** `StateMachine` — same
tables, same wake mirror, same handles, one capability instance — so
everything here is available through `this.tasks` too, and a host that
composes both APIs installs only `Tasks`.

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  StateMachine,
  type StateMachineDefinition
} from "agents/state-machine";

type Session =
  | { phase: "idle"; turns: number }
  | { phase: "turn"; turns: number };

const session = {
  initial: { phase: "idle", turns: 0 } as Session,
  phases: {
    idle: async (state, ctx) => {
      const item = await ctx.receive({ kind: "message" });
      if (item === ctx.timedOut) return state;
      return { phase: "turn", turns: state.turns + 1 };
    },
    turn: async (state, ctx) => {
      await ctx.do(`reply:${state.turns}`, () => reply());
      return { phase: "idle", turns: state.turns };
    }
  }
} satisfies StateMachineDefinition<Session, string>;

export class SessionObject extends DurableObject<Env> {
  readonly machines = new StateMachine({ definitions: { session } });
  readonly lifecycle = Lifecycle.install(this).use(this.machines);
}
```

## Vocabulary

The engine's names carry the `StateMachine` prefix; every `Task*` name on
the Tasks page is the same type under the name Tasks shipped with, and each
`Task*Error` is the same class as its `StateMachine*Error`.

| `agents/tasks`                                        | `agents/state-machine`                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Tasks`, `TasksOptions`                               | `StateMachine`, `StateMachineOptions`                                                 |
| `TaskMachine`                                         | `StateMachineDefinition`                                                              |
| `TaskContext`                                         | `StateMachineContext`                                                                 |
| `TaskStep`                                            | `StateMachineStep`                                                                    |
| `TaskRunHandle`, `TaskHandle`                         | `StateMachineRunHandle`, `StateMachineHandle`                                         |
| `TaskReceipt`, `TaskRunSnapshot`, `TaskRunView`       | `StateMachineReceipt`, `StateMachineRunSnapshot`, `StateMachineRunView`               |
| `TaskInput`, `TaskState`, `TaskOutput`, `TaskMailbox` | `StateMachineInput`, `StateMachineState`, `StateMachineOutput`, `StateMachineMailbox` |
| `TaskNoProgressError`, …                              | `StateMachineNoProgressError`, …                                                      |
| `defineAsk`, `AskKind`, `Pending`, `AssertJson`       | the same, unprefixed                                                                  |

Only the job form — `TaskFunction`, `TaskHandlers`, `TaskCallbacks`, and a
definition map that mixes functions and machines — belongs to
`agents/tasks`. A `StateMachine` registers machines only.

Storage tables (`cf_agents_task_*`) and event types (`task:*`) keep the
`task` namespace under both entry points: a task run and a state-machine
run are the same row. The engine errors' runtime `name` reads
`StateMachine…`.

For the machine form itself — phases, `satisfies`, the runtime, progress
rules, the abort protocol, versioning — read
[Durable actors on the Tasks page](./tasks.md#durable-actors-the-machine).
