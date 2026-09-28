export type HarnessDriverSubmissionStatus = "queued" | "admitted";

export type HarnessDriverError = {
  readonly name: string;
  readonly message: string;
};

export type HarnessDriverSubmission<Input = unknown> = {
  readonly seq: number;
  readonly driverId: string;
  readonly scope: string;
  readonly operationId: string;
  readonly input: Input;
  readonly status: HarnessDriverSubmissionStatus;
  readonly streamId: string | null;
  readonly submittedAt: number;
  readonly admittedAt: number | null;
  readonly attempts: number;
  readonly failure: HarnessDriverError | null;
  readonly cancelRequested: boolean;
};

export type HarnessDriverEnqueueResult<Input = unknown> = {
  readonly accepted: boolean;
  readonly submission: HarnessDriverSubmission<Input>;
};

export type HarnessDriverInspection<Result> =
  | { readonly status: "not-admitted" }
  | { readonly status: "active" }
  | { readonly status: "waiting"; readonly notBefore?: number }
  | { readonly status: "completed"; readonly result: Result }
  | {
      readonly status: "failed";
      readonly error: { readonly name: string; readonly message: string };
    };

export type HarnessDriverDriveResult<Result> =
  | { readonly status: "continue" }
  | { readonly status: "waiting"; readonly notBefore: number }
  | { readonly status: "completed"; readonly result: Result };

export type HarnessDriverCancellation<Result = unknown> =
  | { readonly status: "cancelled" }
  | { readonly status: "not-found" }
  | { readonly status: "completed"; readonly result: Result }
  | { readonly status: "pending"; readonly notBefore?: number };

export interface HarnessDriverRuntime<Input, Result> {
  inspect(
    scope: string,
    operationId: string
  ): Promise<HarnessDriverInspection<Result>>;
  admit(scope: string, operationId: string, input: Input): Promise<void>;
  drive(
    scope: string,
    operationId: string,
    signal: AbortSignal
  ): Promise<HarnessDriverDriveResult<Result>>;
  cancel(
    scope: string,
    operationId: string
  ): Promise<HarnessDriverCancellation<Result>>;
}

export type HarnessDriverOptions<Input, Result> = {
  readonly id: string;
  readonly runtime: HarnessDriverRuntime<Input, Result>;
  readonly settle?: (
    submission: HarnessDriverSubmission<Input>,
    result: Result
  ) => void | Promise<void>;
  readonly cancelTools?: (
    submission: HarnessDriverSubmission<Input>
  ) => void | Promise<void>;
  readonly fail?: (
    submission: HarnessDriverSubmission<Input>,
    error: HarnessDriverError
  ) => void | Promise<void>;
  readonly heartbeatMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
};

export type HarnessDriverSubmitOptions = {
  readonly operationId?: string;
  readonly streamId?: string;
};

export type HarnessDriverReceipt = {
  readonly operationId: string;
  readonly scope: string;
  readonly accepted: boolean;
  readonly submittedAt: number;
};
