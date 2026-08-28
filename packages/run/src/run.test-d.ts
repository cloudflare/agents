import { expectTypeOf } from "vitest";
import {
  getHostFunctionContext,
  run,
  RunError,
  type HostFunction,
  type HostFunctionContext,
  type HostFunctions,
  type RunErrorCode,
  type RunErrorDetails,
  type RunLimits,
  type RunLog,
  type RunOptions,
  type RunResult
} from "./index";

declare const loader: WorkerLoader;

const add = (left: number, right: number): number => left + right;
expectTypeOf(add).toMatchTypeOf<HostFunction>();

const hostFunctions = {
  math: { add }
} satisfies HostFunctions;

const invocation = run<number>({
  loader,
  source: "return await math.add(20, 22);",
  hostFunctions
});

expectTypeOf(invocation).toEqualTypeOf<Promise<RunResult<number>>>();
expectTypeOf<
  Awaited<typeof invocation>["status"]
>().toEqualTypeOf<"completed">();
expectTypeOf<Awaited<typeof invocation>["value"]>().toEqualTypeOf<number>();
expectTypeOf<RunError["code"]>().toEqualTypeOf<RunErrorCode>();
expectTypeOf<RunError["logs"]>().toEqualTypeOf<RunLog[]>();
expectTypeOf<RunOptions["limits"]>().toEqualTypeOf<RunLimits | undefined>();
expectTypeOf<RunError["details"]>().toEqualTypeOf<
  RunErrorDetails | undefined
>();
expectTypeOf<HostFunctionContext["signal"]>().toEqualTypeOf<AbortSignal>();
expectTypeOf(
  getHostFunctionContext
).returns.toEqualTypeOf<HostFunctionContext>();

expectTypeOf<RunLimits>().toEqualTypeOf<{
  timeoutMs?: number;
  cpuMs?: number;
  subRequests?: number;
  maxSourceBytes?: number;
  maxLogBytes?: number;
  maxHostFunctionCalls?: number;
  maxConcurrentHostFunctionCalls?: number;
}>();
expectTypeOf<RunErrorDetails["limit"]>().toEqualTypeOf<
  keyof RunLimits | undefined
>();
