/**
 * Loopback bindings for dynamic workers
 *
 * These WorkerEntrypoint classes are instantiated via ctx.exports and passed
 * to dynamic workers loaded via the LOADER binding. When the dynamic worker
 * calls methods on these bindings, the calls are proxied back to the parent
 * Agent where the actual work is done.
 *
 * This pattern allows us to:
 * 1. Control what capabilities dynamic workers have
 * 2. Share state (like the Bash filesystem) across executions
 * 3. Audit and log all operations
 * 4. Enforce security policies
 */

export { BashLoopback, type BashLoopbackProps, type BashResult } from "./bash";
export { EchoLoopback, type EchoLoopbackProps } from "./echo";
export {
  FetchLoopback,
  type FetchLoopbackProps,
  type FetchResult,
  type FetchError,
  type FetchLogEntry
} from "./fetch";
export { FSLoopback, type FSLoopbackProps, type FileStat } from "./fs";
