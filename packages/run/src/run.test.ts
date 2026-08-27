import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { run, RunError } from "./index";

const LOCAL_DYNAMIC_WORKER_LOADER: WorkerLoader = {
  get(name, getCode) {
    return env.LOADER.get(name, async () => ({
      ...(await getCode()),
      compatibilityDate: "2026-08-06"
    }));
  },
  load(code) {
    // ponytail: local workerd currently stops at 2026-08-06; remove this adapter once it supports Run's pinned 2026-08-27 child date.
    return env.LOADER.load({ ...code, compatibilityDate: "2026-08-06" });
  }
};

it("returns an explicit JavaScript value from a fresh Dynamic Worker", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return 42;"
  });

  expect(result).toEqual({
    status: "completed",
    value: 42,
    logs: []
  });
});

it.each([
  ["top-level await", "await Promise.resolve(); return 7;", 7],
  ["empty source", "", undefined],
  ["fallthrough", "void 0;", undefined],
  ["bare expression", "21 + 21;", undefined]
])("executes %s as an async function body", async (_name, source, expected) => {
  const result = await run({ loader: LOCAL_DYNAMIC_WORKER_LOADER, source });

  expect(result.value).toBe(expected);
});

it("calls an exact namespaced synchronous host function", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await math.add(20, 22);",
    hostFunctions: {
      math: {
        add(left: number, right: number) {
          return left + right;
        }
      }
    }
  });

  expect(result.value).toBe(42);
});

it("awaits an asynchronous host function with exact positional data", async () => {
  const result = await run<{ names: string[] }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
return await users.lookup({ ids: [1, 2] }, "!");
`,
    hostFunctions: {
      users: {
        async lookup(query: { ids: number[] }, suffix: string) {
          await Promise.resolve();
          return { names: query.ids.map((id) => `user-${id}${suffix}`) };
        }
      }
    }
  });

  expect(result.value).toEqual({ names: ["user-1!", "user-2!"] });
});

it("shows generated code only a generic host failure", async () => {
  const result = await run<{
    name: string;
    message: string;
    code: string;
    containsHostMessage: boolean;
  }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
try {
  await tools.fail();
  return null;
} catch (error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    containsHostMessage: error.stack.includes("private host detail")
  };
}
`,
    hostFunctions: {
      tools: {
        fail() {
          throw new Error("private host detail");
        }
      }
    }
  });

  expect(result.value).toEqual({
    name: "RunHostFunctionError",
    message: "Host function failed.",
    code: "RUN_HOST_FUNCTION_ERROR",
    containsHostMessage: false
  });
});

it("rejects an escaping sanitized host failure as RunError", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.fail();",
    hostFunctions: {
      tools: {
        fail() {
          throw new Error("private host detail");
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_HOST_FUNCTION_ERROR",
    message: "Host function failed.",
    logs: []
  });
  expect(String(failure)).not.toContain("private host detail");
});

it("classifies malformed JavaScript as a compile error", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return (;"
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_COMPILE_ERROR",
    logs: []
  });
});

it.each([
  ["synchronous throw", 'throw new Error("sync boom");', "sync boom"],
  [
    "asynchronous rejection",
    'await Promise.reject(new Error("async boom"));',
    "async boom"
  ]
])("rejects a generated %s as RunError", async (_name, source, message) => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR",
    message,
    logs: []
  });
});

it("contains a generated Error with throwing diagnostic getters", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const error = new Error("hidden");
Object.defineProperty(error, "message", {
  get() { throw new Error("message getter escaped"); }
});
throw error;
`
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR",
    message: "Generated code threw an error."
  });
  expect(String(failure)).not.toContain("message getter escaped");
});

it("contains guest changes to WeakSet methods used for error branding", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
WeakSet.prototype.add = () => { throw new Error("brand add escaped"); };
WeakSet.prototype.has = () => { throw new Error("brand check escaped"); };
await tools.fail();
`,
    hostFunctions: {
      tools: {
        fail() {
          throw new Error("private host detail");
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_HOST_FUNCTION_ERROR",
    message: "Host function failed."
  });
  expect(String(failure)).not.toContain("brand");
});

it("contains a generated proxy that throws during error inspection", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
console.warn("before proxy failure");
throw new Proxy({}, {
  getPrototypeOf() { throw new Error("prototype trap escaped"); }
});
`
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR",
    message: "Generated code threw an error.",
    logs: [{ level: "warn", message: "before proxy failure" }]
  });
  expect(String(failure)).not.toContain("prototype trap escaped");
});

it("retains captured logs on a generated failure", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: 'console.warn("before failure"); throw new Error("boom");'
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR",
    logs: [{ level: "warn", message: "before failure" }]
  });
});

it("classifies a host result serialization failure", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.invalidResult();",
    hostFunctions: {
      tools: {
        invalidResult() {
          return Symbol("not serializable");
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_SERIALIZATION_ERROR",
    logs: []
  });
});

it("classifies a final result serialization failure", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: 'return Symbol("not serializable");'
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_SERIALIZATION_ERROR",
    logs: []
  });
});

it("provides no parent bindings to generated code", async () => {
  expect(env.PARENT_ONLY).toBe("parent binding");

  const result = await run<{ env: string; parentBinding: string }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
return {
  env: typeof env,
  parentBinding: typeof PARENT_ONLY
};
`
  });

  expect(result.value).toEqual({
    env: "undefined",
    parentBinding: "undefined"
  });
});

it("blocks direct outbound fetch from generated code", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: 'return await fetch("https://example.com");'
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR"
  });
});

it("uses fresh child global state for every invocation", async () => {
  const source = `
globalThis.__runInvocationCount =
  (globalThis.__runInvocationCount ?? 0) + 1;
return globalThis.__runInvocationCount;
`;

  const values = [];
  for (let index = 0; index < 5; index++) {
    const result = await run<number>({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source
    });
    values.push(result.value);
  }

  expect(values).toEqual([1, 1, 1, 1, 1]);
});

it("captures all console levels in child execution order", async () => {
  const parentConsoleLevels = [
    "debug",
    "info",
    "log",
    "warn",
    "error"
  ] as const;
  const parentConsole = parentConsoleLevels.map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {})
  );
  try {
    const result = await run<string>({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: `
console.debug("debug", 1);
console.info("info", true);
console.log("log", null, undefined, 9n);
console.warn("warn");
console.error("error");
return "done";
`
    });

    expect(result).toEqual({
      status: "completed",
      value: "done",
      logs: [
        { level: "debug", message: "debug 1" },
        { level: "info", message: "info true" },
        { level: "log", message: "log null undefined 9n" },
        { level: "warn", message: "warn" },
        { level: "error", message: "error" }
      ]
    });
    for (const parentMethod of parentConsole) {
      expect(parentMethod).not.toHaveBeenCalled();
    }
  } finally {
    for (const parentMethod of parentConsole) parentMethod.mockRestore();
  }
});
