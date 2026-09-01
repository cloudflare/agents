/**
 * Compiling fixture for the README examples. Each block mirrors a README
 * code sample; if the public interface drifts, this file fails typecheck
 * and the README must be updated with it.
 */
import { expectTypeOf } from "vitest";
import { getHostFunctionContext, run, RunError, type RunResult } from "./index";

interface Env {
  LOADER: WorkerLoader;
}

/** README "Quick start" example. */
export const quickStartWorker = {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await run<number>({
      loader: env.LOADER,
      source: `
interface Pair { left: number; right: number }
const pair: Pair = { left: 20, right: 22 };
console.log("adding", pair.left, pair.right);
return pair.left + pair.right satisfies number;
`
    });

    expectTypeOf(result).toEqualTypeOf<RunResult<number>>();
    return Response.json(result);
  }
};

/** README "Host functions and cancellation" example. */
export async function hostFunctionExample(
  env: Env,
  request: Request
): Promise<{ id: string; name: string }> {
  const result = await run<{ id: string; name: string }>({
    loader: env.LOADER,
    source: `
const user = await users.find("123");
return user;
`,
    hostFunctions: {
      users: {
        async find(id: string) {
          const { signal } = getHostFunctionContext();
          const response = await fetch(`https://example.com/users/${id}`, {
            signal
          });
          return response.json();
        }
      }
    },
    signal: request.signal
  }).catch((error: unknown) => {
    if (error instanceof RunError) {
      console.error(error.code, error.logs);
    }
    throw error;
  });

  return result.value;
}

/** README "Handling failures" example. */
export function describeRunFailure(error: unknown): string {
  if (!(error instanceof RunError)) throw error;
  switch (error.code) {
    case "RUN_TIMEOUT":
    case "RUN_ABORTED":
      return "stopped";
    case "RUN_COMPILE_ERROR":
    case "RUN_EXECUTION_ERROR":
      return "code failed";
    case "RUN_INVALID_INPUT":
    case "RUN_SOURCE_TOO_LARGE":
    case "RUN_HOST_FUNCTION_ERROR":
    case "RUN_HOST_FUNCTION_LIMIT":
    case "RUN_DETACHED_HOST_FUNCTION":
    case "RUN_SERIALIZATION_ERROR":
    case "RUN_RESOURCE_LIMIT":
    case "RUN_WORKER_ERROR":
      return error.code;
    default:
      return error.code satisfies never;
  }
}
