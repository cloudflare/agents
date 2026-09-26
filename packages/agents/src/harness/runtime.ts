import {
  effectPending,
  type MachineEffectRuntime,
  type MachineJson,
  type MachineValue
} from "../state-machine";

function assertNever(value: never): never {
  throw new Error(`Unexpected harness runtime inspection: ${String(value)}`);
}

export interface HarnessRuntimeInvocation {
  readonly executionId: string;
  readonly signal: AbortSignal;
}

export type HarnessRuntimeInspection<
  Result extends MachineValue,
  Progress = unknown
> =
  | { readonly status: "running"; readonly progress?: Progress }
  | { readonly status: "completed"; readonly result: Result }
  | {
      readonly status: "failed";
      readonly error: { readonly name: string; readonly message: string };
    }
  | { readonly status: "not-found" };

/** Existing durable execution runtime wrapped by an outer harness machine. */
export interface HarnessRuntime<
  Input extends MachineJson,
  Result extends MachineValue,
  Progress = unknown
> {
  start(input: Input, invocation: HarnessRuntimeInvocation): Promise<void>;
  inspect(
    executionId: string
  ): Promise<HarnessRuntimeInspection<Result, Progress>>;
  cancel?(executionId: string): Promise<void>;
}

/** Adapt one durable runtime to StateMachine's reconcile effect protocol. */
export function createHarnessEffectRuntime<
  Input extends MachineJson,
  Result extends MachineValue,
  Progress = unknown
>(
  runtime: HarnessRuntime<Input, Result, Progress>
): MachineEffectRuntime<Input, Result> {
  return {
    execute: async (input, invocation) => {
      const executionId = invocation.externalId ?? invocation.effectId;
      await runtime.start(input, {
        executionId,
        signal: invocation.signal
      });
      const inspected = await runtime.inspect(executionId);
      switch (inspected.status) {
        case "running":
          return effectPending(executionId);
        case "completed":
          return inspected.result;
        case "failed": {
          const error = new Error(inspected.error.message);
          error.name = inspected.error.name;
          throw error;
        }
        case "not-found":
          throw new Error(
            `Harness execution "${executionId}" was not found after start`
          );
        default:
          return assertNever(inspected);
      }
    },
    reconcile: async (externalId, _invocation) => {
      const inspected = await runtime.inspect(externalId);
      switch (inspected.status) {
        case "running":
          return { status: "running" };
        case "completed":
          return { status: "completed", output: inspected.result };
        case "failed":
          return { status: "failed", error: inspected.error };
        case "not-found":
          return { status: "not-found" };
        default:
          return assertNever(inspected);
      }
    },
    ...(runtime.cancel
      ? {
          cancel: (externalId, _invocation) => runtime.cancel!(externalId)
        }
      : {})
  };
}
