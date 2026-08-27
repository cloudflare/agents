import type { RunLog } from "./run-types";

/** Names exposed to caller source for one host-function namespace. */
export interface RunHostFunctionManifestEntry {
  readonly namespace: string;
  readonly functions: readonly string[];
}

/** Data-only response from one parent-side host-function dispatch. */
export type RunHostFunctionResponse =
  | { readonly status: "completed"; readonly value: unknown }
  | { readonly status: "failed" };

/** Parent dispatcher capability passed to the generated Worker entrypoint. */
export interface RunHostFunctionDispatcherContract {
  callHostFunction(
    namespace: string,
    functionName: string,
    args: unknown[]
  ): Promise<RunHostFunctionResponse>;
}

/** Diagnostic returned by the generated Worker. */
export interface RunWorkerErrorRecord {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

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
