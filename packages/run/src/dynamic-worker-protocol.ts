import type { RunLog } from "./run-types";

/** Names exposed to caller source for one host-function namespace. */
export interface RunHostFunctionManifestEntry {
  readonly namespace: string;
  readonly functions: readonly string[];
}

/** Data-only response from one parent-side host-function dispatch. */
export type RunHostFunctionResponse =
  | { readonly status: "completed"; readonly value: unknown }
  | { readonly status: "failed"; readonly failureId: number }
  | { readonly status: "protocolFailed" }
  | { readonly status: "serializationFailed" };

/** Parent dispatcher capability passed to the generated Worker entrypoint. */
export interface RunHostFunctionDispatcherContract {
  /** Start one exact, sequentially identified host-function invocation. */
  callHostFunction(
    callId: number,
    namespace: string,
    functionName: string,
    args: unknown[]
  ): Promise<RunHostFunctionResponse>;
}

interface RunWorkerErrorDiagnostic {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** Valid machine-readable field combinations for one generated Worker error. */
export type RunWorkerErrorClassification =
  | {
      readonly code?: undefined;
      readonly path?: never;
      readonly hostFunction?: never;
      readonly hostFailureId?: never;
    }
  | {
      readonly code: "RUN_HOST_FUNCTION_ERROR";
      readonly hostFailureId: number;
      readonly path?: never;
      readonly hostFunction?: never;
    }
  | {
      readonly code: "RUN_INVALID_INPUT";
      readonly path: "hostFunctions.namespace";
      readonly hostFunction?: never;
      readonly hostFailureId?: never;
    }
  | ({
      readonly code: "RUN_SERIALIZATION_ERROR";
      readonly hostFailureId?: never;
    } & (
      | {
          readonly path: "result";
          readonly hostFunction?: never;
        }
      | {
          readonly path: "hostFunction.arguments" | "hostFunction.result";
          readonly hostFunction: string;
        }
    ))
  | {
      readonly code: "RUN_WORKER_ERROR";
      readonly hostFunction?: string;
      readonly path?: never;
      readonly hostFailureId?: never;
    };

/** Diagnostic returned by the generated Worker with valid fields for its code. */
export type RunWorkerErrorRecord = RunWorkerErrorDiagnostic &
  RunWorkerErrorClassification;

/** Terminal data-only response from the generated Worker. */
export type RunWorkerResponse =
  | {
      readonly status: "completed";
      readonly value: unknown;
      readonly logs: RunLog[];
    }
  | {
      readonly status: "failed";
      readonly error: RunWorkerErrorRecord;
      readonly logs: RunLog[];
    };
