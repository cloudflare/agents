import { DurableObject } from "cloudflare:workers";
import {
  StateMachine,
  defineAsk,
  NonRetryableError,
  StateMachineCancelCannotParkError,
  StateMachineCheckpointTooLargeError,
  StateMachineDeadlineExceededError,
  StateMachineMissingDefinitionError,
  StateMachineSerializationError,
  StateMachineTransitionBudgetError,
  type AnyStateMachineDefinition,
  type Pending,
  type StateMachineContext,
  type StateMachineDefinition,
  type StateMachineDefinitions,
  type StateMachineHandle,
  type StateMachineInput,
  type StateMachineOutput,
  type StateMachineReceipt,
  type StateMachineRunHandle,
  type StateMachineState
} from "../state-machine";
import { Tasks } from "../tasks";

type Order =
  | { phase: "placed"; sku: string }
  | { phase: "charged"; sku: string; charge: string };

const approval = defineAsk<{ sku: string }, boolean>("approval");

const order = {
  initial: (seed: { sku: string }): Order => ({ phase: "placed", ...seed }),
  phases: {
    placed: async (state, ctx) => {
      // The state narrows to its own phase; `ctx` carries the machine verbs.
      state.sku satisfies string;
      const [pending] = ctx.ask(approval, [{ sku: state.sku }]);
      pending satisfies Pending<boolean> | undefined;
      return { phase: "charged", sku: state.sku, charge: "ch_1" } as const;
    },
    charged: async (state, ctx) => ctx.complete(state.charge)
  }
} satisfies StateMachineDefinition<Order, never, string, { sku: string }>;

// The engine's own class, machine definitions only.
class OrderObject extends DurableObject {
  readonly machines = new StateMachine({ definitions: { order } });

  async start(): Promise<StateMachineReceipt> {
    // Input is the seed; the handles are typed by the definition.
    const receipt = await this.machines.run("order", { sku: "sku-1" });
    const handle: StateMachineRunHandle<typeof order> = this.machines.at(
      "order",
      receipt.runId
    );
    handle.definition satisfies string;
    const lens: StateMachineHandle<
      typeof order,
      { sku: string },
      Order,
      string
    > = this.machines.handle("order");
    lens.name satisfies string;
    // @ts-expect-error -- the seed is required, and typed
    await this.machines.run("order", { sku: 1 });
    // @ts-expect-error -- unknown definition names are rejected at the type level
    await this.machines.run("missing", undefined);
    return receipt;
  }
}
void OrderObject;

// The extractors read the machine's shape.
({}) as StateMachineInput<typeof order> satisfies { sku: string };
({}) as StateMachineState<typeof order> satisfies Order;
"" as StateMachineOutput<typeof order> satisfies string;

// A machine map is a valid engine registry; a durable function is not.
({ order }) satisfies StateMachineDefinitions;
// @ts-expect-error -- durable functions belong to `agents/tasks`
({ fn: async () => "x" }) satisfies StateMachineDefinitions;
order satisfies AnyStateMachineDefinition;

// A Tasks IS a StateMachine: the wrapper runs machine definitions too.
const tasks = new Tasks({ definitions: { order } });
tasks.run("order", { sku: "sku-1" }) satisfies Promise<StateMachineReceipt>;
tasks satisfies StateMachine<{ order: typeof order }>;

// Context typing: the phase handler's `ctx` is the machine context.
type Ctx = StateMachineContext<Order, never, string, { sku: string }>;
({}) as Ctx satisfies { readonly input: { sku: string } };

// Errors keep their identities across both entry points.
new StateMachineCheckpointTooLargeError(
  "x",
  1,
  0
) satisfies StateMachineSerializationError;
new StateMachineTransitionBudgetError("r", 1, ["placed"]) satisfies Error;
new StateMachineCancelCannotParkError("ask") satisfies Error;
new StateMachineDeadlineExceededError("r", 0) satisfies Error;
new StateMachineMissingDefinitionError("d") satisfies Error;
new NonRetryableError("x") satisfies Error;
