import type { StateMachine } from "../state-machine";
import type {
  MachineDefinitions,
  MachineEvent,
  MachineEventOf,
  MachineInput,
  MachineOutput,
  MachineRunSnapshot,
  MachineSendReceipt,
  MachineState
} from "../state-machine";
import type {
  AgentHarness,
  HarnessNotifyOptions,
  HarnessReceipt,
  HarnessStartOptions
} from "./types";

export interface StateMachineHarnessOptions<
  Definitions extends MachineDefinitions,
  Name extends keyof Definitions & string
> {
  readonly stateMachine: StateMachine<Definitions>;
  readonly definition: Name;
}

/**
 * A lifecycle adapter over one named StateMachine definition.
 *
 * It owns no phases or storage and can be composed inside a richer harness.
 */
export class StateMachineHarness<
  Definitions extends MachineDefinitions,
  Name extends keyof Definitions & string
> implements AgentHarness<
  MachineInput<Definitions[Name]>,
  MachineEventOf<Definitions[Name]>,
  MachineRunSnapshot<
    MachineState<Definitions[Name]>,
    MachineOutput<Definitions[Name]>
  >,
  MachineOutput<Definitions[Name]>,
  MachineSendReceipt
> {
  readonly #stateMachine: StateMachine<Definitions>;
  readonly #definition: Name;

  constructor(options: StateMachineHarnessOptions<Definitions, Name>) {
    this.#stateMachine = options.stateMachine;
    this.#definition = options.definition;
  }

  async start(
    input: MachineInput<Definitions[Name]>,
    options: HarnessStartOptions = {}
  ): Promise<HarnessReceipt> {
    const receipt = await this.#stateMachine.run(
      this.#definition,
      input,
      options
    );
    return {
      runId: receipt.runId,
      accepted: receipt.accepted,
      createdAt: receipt.createdAt
    };
  }

  notify(
    runId: string,
    event: MachineEventOf<Definitions[Name]>,
    options: HarnessNotifyOptions
  ): Promise<MachineSendReceipt> {
    return this.#stateMachine.send(runId, event as MachineEvent, options);
  }

  inspect(
    runId: string
  ): Promise<MachineRunSnapshot<
    MachineState<Definitions[Name]>,
    MachineOutput<Definitions[Name]>
  > | null> {
    return this.#stateMachine.get(runId, this.#definition);
  }

  async abort(runId: string, reason?: string): Promise<boolean> {
    const receipt = await this.#stateMachine.cancel(runId, reason);
    return receipt.status === "requested";
  }

  pause(runId: string): Promise<boolean> {
    return this.#stateMachine.pause(runId);
  }

  resume(runId: string): Promise<boolean> {
    return this.#stateMachine.resume(runId);
  }

  async result(
    runId: string
  ): Promise<MachineOutput<Definitions[Name]> | null> {
    const snapshot = await this.inspect(runId);
    return snapshot?.status === "completed" ? snapshot.result : null;
  }
}
