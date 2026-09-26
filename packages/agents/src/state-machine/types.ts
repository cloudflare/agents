export type MachineJson =
  | string
  | number
  | boolean
  | null
  | MachineJson[]
  | { [key: string]: MachineJson };

export type MachineValue = MachineJson | undefined | void;
export type MachinePhased = { phase: string } & Record<string, MachineJson>;

export interface MachineCommitTransaction {
  /** Run a synchronous notification only after the outer transaction commits. */
  afterCommit(callback: () => void): void;
}

export interface MachineCommitParticipant {
  /** @internal Runtime validation prevents application-created participants. */
  readonly __brand: "MachineCommitParticipant";
}

export interface MachineTransitionOptions {
  readonly commit?: readonly MachineCommitParticipant[];
}

export type MachineDecision<
  State extends MachinePhased,
  Result extends MachineValue
> =
  | {
      readonly kind: "transition";
      readonly state: State;
      readonly commit: readonly MachineCommitParticipant[];
    }
  | {
      readonly kind: "complete";
      readonly result: Result;
      readonly commit: readonly MachineCommitParticipant[];
    }
  | {
      readonly kind: "fail";
      readonly error: { readonly name: string; readonly message: string };
      readonly commit: readonly MachineCommitParticipant[];
    };

export interface MachineContext<
  State extends MachinePhased,
  Result extends MachineValue
> {
  readonly runId: string;
  readonly revision: number;
  transition(
    state: State,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
  complete(
    result: Result,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
  fail(
    error: unknown,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
}

export interface MachineDefinition<
  State extends MachinePhased,
  Result extends MachineValue = void,
  Input extends MachineValue = undefined
> {
  readonly version: number;
  readonly initial: (input: Input) => State;
  readonly phases: {
    [Phase in State["phase"]]: (
      state: Extract<State, { phase: Phase }>,
      context: MachineContext<State, Result>
    ) =>
      | MachineDecision<State, Result>
      | Promise<MachineDecision<State, Result>>;
  };
}

export type AnyMachineDefinition = {
  readonly version: number;
  readonly initial: (input: never) => MachinePhased;
  readonly phases: Record<string, (state: never, context: never) => unknown>;
};

export type MachineDefinitions = Record<string, AnyMachineDefinition>;

export type MachineInput<Definition> = Definition extends {
  initial: (input: infer Input) => unknown;
}
  ? Input
  : never;

export type MachineOutput<Definition> = Definition extends {
  phases: infer Phases;
}
  ? Phases extends Record<string, (...args: never[]) => unknown>
    ? Awaited<ReturnType<Phases[keyof Phases]>> extends MachineDecision<
        MachinePhased,
        infer Output
      >
      ? Output
      : never
    : never
  : never;

export type MachineState<Definition> = Definition extends {
  initial: (...args: never[]) => infer State;
}
  ? State extends MachinePhased
    ? State
    : never
  : never;

export interface MachineRunOptions {
  readonly runId?: string;
  readonly idempotencyKey?: string;
  readonly retain?: boolean;
}

export interface MachineReceipt {
  readonly runId: string;
  readonly definition: string;
  readonly accepted: boolean;
  readonly createdAt: number;
}

export type MachineRunSnapshot<
  State extends MachinePhased = MachinePhased,
  Result extends MachineValue = MachineValue
> =
  | {
      readonly runId: string;
      readonly definition: string;
      readonly definitionVersion: number;
      readonly status: "running";
      readonly state: State;
      readonly revision: number;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly runId: string;
      readonly definition: string;
      readonly definitionVersion: number;
      readonly status: "completed";
      readonly result: Result;
      readonly revision: number;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly settledAt: number;
    }
  | {
      readonly runId: string;
      readonly definition: string;
      readonly definitionVersion: number;
      readonly status: "failed";
      readonly error: { readonly name: string; readonly message: string };
      readonly revision: number;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly settledAt: number;
    };

/** @internal Raw StateMachine run row. */
export interface MachineRunRow {
  run_id: string;
  definition: string;
  definition_version: number;
  status: "running" | "completed" | "failed";
  phase: string | null;
  checkpoint_json: string | null;
  revision: number;
  control_json: string;
  job_id: string | null;
  result_json: string | null;
  error_name: string | null;
  error_message: string | null;
  retain: number;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}
