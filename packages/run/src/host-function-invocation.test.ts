import { expect, it } from "vitest";
import { getHostFunctionContext, run, RunError } from "./index";
import { LOCAL_DYNAMIC_WORKER_LOADER } from "./run-test-worker-loader";

it("runs sequential host calls in source order", async () => {
  const calls: number[] = [];
  const result = await run<number[]>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return [await tools.record(1), await tools.record(2)];",
    hostFunctions: {
      tools: {
        record(value: number) {
          calls.push(value);
          return value;
        }
      }
    }
  });

  expect(result.value).toEqual([1, 2]);
  expect(calls).toEqual([1, 2]);
});

it("runs concurrent host calls and matches out-of-order results to each promise", async () => {
  const settled: number[] = [];
  let releaseFirst: (() => void) | undefined;

  const result = await run<number[]>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const first = tools.wait(1);
const second = tools.wait(2);
const observedFirst = first.then((value) => { console.log("first", value); return value; });
const observedSecond = second.then((value) => { console.log("second", value); return value; });
return await Promise.all([observedFirst, observedSecond]);
`,
    hostFunctions: {
      tools: {
        async wait(value: number) {
          if (value === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          } else {
            setTimeout(() => releaseFirst?.(), 0);
          }
          settled.push(value);
          return value;
        }
      }
    }
  });

  expect(result.value).toEqual([1, 2]);
  expect(settled).toEqual([2, 1]);
  expect(result.logs).toEqual([
    { level: "log", message: "second 2" },
    { level: "log", message: "first 1" }
  ]);
});

it("observing one generated host promise repeatedly invokes its host function once", async () => {
  let invocationCount = 0;
  const result = await run<number[]>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const call = tools.once();
return await Promise.all([call, call.then((value) => value), Promise.resolve(call)]);
`,
    hostFunctions: {
      tools: {
        once() {
          invocationCount++;
          return 42;
        }
      }
    }
  });

  expect(result.value).toEqual([42, 42, 42]);
  expect(invocationCount).toBe(1);
});

it("invokes host functions without a receiver", async () => {
  const result = await run<boolean>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.checkThis();",
    hostFunctions: {
      tools: {
        checkThis(this: unknown) {
          return this === undefined;
        }
      }
    }
  });

  expect(result.value).toBe(true);
});

it("provides host-function context before and after awaited work", async () => {
  const result = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.inspectContext();",
    hostFunctions: {
      tools: {
        async inspectContext() {
          const before = getHostFunctionContext();
          await Promise.resolve();
          const after = getHostFunctionContext();
          return {
            sameSignal: before.signal === after.signal,
            aborted: after.signal.aborted
          };
        }
      }
    }
  });

  expect(result.value).toEqual({ sameSignal: true, aborted: false });
});

it("isolates context signals across concurrent host calls", async () => {
  const signals: AbortSignal[] = [];
  let releaseCalls: (() => void) | undefined;
  const callsStarted = new Promise<void>((resolve) => {
    releaseCalls = resolve;
  });

  const result = await run<boolean[]>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await Promise.all([tools.inspect(1), tools.inspect(2)]);",
    hostFunctions: {
      tools: {
        async inspect() {
          const before = getHostFunctionContext().signal;
          signals.push(before);
          if (signals.length === 2) releaseCalls?.();
          await callsStarted;
          return getHostFunctionContext().signal === before;
        }
      }
    }
  });

  expect(result.value).toEqual([true, true]);
  expect(signals).toHaveLength(2);
  expect(signals[0]).not.toBe(signals[1]);
});

it("throws when host-function context is read outside an active invocation", () => {
  expect(() => getHostFunctionContext()).toThrow(
    "Run host function context is available only inside an active host function."
  );
});

it("makes inherited async context inactive after the host function settles", async () => {
  let readDetachedContext: Promise<string> | undefined;

  await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.startDetachedCheck();",
    hostFunctions: {
      tools: {
        startDetachedCheck() {
          readDetachedContext = new Promise((resolve) => {
            setTimeout(() => {
              try {
                getHostFunctionContext();
                resolve("available");
              } catch {
                resolve("unavailable");
              }
            }, 10);
          });
          return "started";
        }
      }
    }
  });

  expect(await readDetachedContext).toBe("unavailable");
});

it.each(["uncaught", "rethrow"])(
  "attaches the exact trusted cause when a sanitized host failure is %s",
  async (behavior) => {
    const trustedCause = new Error("private host diagnostic");
    const source =
      behavior === "rethrow"
        ? "try { await tools.fail(); } catch (error) { throw error; }"
        : "return await tools.fail();";

    const failure = await run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source,
      hostFunctions: {
        tools: {
          fail() {
            throw trustedCause;
          }
        }
      }
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      name: "RunError",
      code: "RUN_HOST_FUNCTION_ERROR",
      message: "Host function failed.",
      details: { hostFunction: "tools.fail" }
    });
    expect(failure).toBeInstanceOf(RunError);
    if (!(failure instanceof RunError)) throw new Error("Expected RunError.");
    expect(failure.cause).toBe(trustedCause);
    expect(String(failure)).not.toContain("private host diagnostic");
  }
);

it("retains an explicit undefined trusted cause", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.fail();",
    hostFunctions: {
      tools: {
        fail() {
          throw undefined;
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw new Error("Expected RunError.");
  expect(failure.code).toBe("RUN_HOST_FUNCTION_ERROR");
  expect(Object.hasOwn(failure, "cause")).toBe(true);
  expect(failure.cause).toBeUndefined();
});

it("does not attach a trusted cause when generated code replaces the host error", async () => {
  const trustedCause = new Error("private host diagnostic");
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
try {
  await tools.fail();
} catch {
  throw new Error("replacement error");
}
`,
    hostFunctions: {
      tools: {
        fail() {
          throw trustedCause;
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR",
    message: "replacement error"
  });
  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw new Error("Expected RunError.");
  expect(Object.hasOwn(failure, "cause")).toBe(false);
});

it("retains a throwing trusted cause without inspecting it", async () => {
  const trustedCause = new Proxy(
    {},
    {
      get() {
        throw new Error("private cause inspection");
      },
      getPrototypeOf() {
        throw new Error("private cause prototype");
      }
    }
  );
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.fail();",
    hostFunctions: {
      tools: {
        fail() {
          throw trustedCause;
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    code: "RUN_HOST_FUNCTION_ERROR",
    message: "Host function failed."
  });
  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw new Error("Expected RunError.");
  expect(failure.cause).toBe(trustedCause);
});

it("bounds the exact host name placed in error details", async () => {
  const namespace = `n${"a".repeat(199)}`;
  const functionName = `f${"b".repeat(199)}`;
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `return await ${namespace}.${functionName}();`,
    hostFunctions: {
      [namespace]: {
        [functionName]() {
          throw new Error("private host diagnostic");
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    code: "RUN_HOST_FUNCTION_ERROR",
    message: "Host function failed."
  });
  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw new Error("Expected RunError.");
  const hostFunction = failure.details?.hostFunction;
  expect(hostFunction).toBeTypeOf("string");
  if (hostFunction === undefined) throw new Error("Expected host function.");
  expect(new TextEncoder().encode(hostFunction)).toHaveLength(256);
  expect(hostFunction.endsWith("…")).toBe(true);
});
