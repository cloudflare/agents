export type DurableToolOwner = {
  readonly driverId: string;
  readonly scope: string;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly mode: "foreground" | "background";
  readonly cancellation: "with-parent" | "detached";
};

export type DurableToolError = {
  readonly name: string;
  readonly message: string;
};

export type DurableToolRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DurableToolRun<Input = unknown, Result = unknown> = {
  readonly runId: string;
  readonly coordinatorId: string;
  readonly owner: DurableToolOwner;
  readonly input: Input;
  readonly status: DurableToolRunStatus;
  readonly result: Result | null;
  readonly error: DurableToolError | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type DurableToolInspection<Result> =
  | { readonly status: "not-started" }
  | { readonly status: "running"; readonly notBefore?: number }
  | { readonly status: "completed"; readonly result: Result }
  | { readonly status: "failed"; readonly error: DurableToolError }
  | { readonly status: "cancelled" };

export interface DurableToolRuntime<Input, Result> {
  inspect(
    runId: string,
    owner: DurableToolOwner
  ): Promise<DurableToolInspection<Result>>;
  start(runId: string, input: Input, owner: DurableToolOwner): Promise<void>;
  cancel(runId: string, owner: DurableToolOwner): Promise<void>;
}

export type DurableToolRunsOptions<Input, Result> = {
  readonly id: string;
  readonly runtime: DurableToolRuntime<Input, Result>;
  readonly wake: (owner: DurableToolOwner) => void | Promise<void>;
  readonly heartbeatMs?: number;
};

export type DurableToolStartResult<Input, Result> = {
  readonly accepted: boolean;
  readonly run: DurableToolRun<Input, Result>;
};
