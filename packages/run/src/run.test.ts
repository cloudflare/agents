import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { run, RunError } from "./index";
import { LOCAL_DYNAMIC_WORKER_LOADER } from "./run-test-worker-loader";

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

it("contains guest changes to collection methods used for error branding", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
WeakMap.prototype.set = () => { throw new Error("brand set escaped"); };
WeakMap.prototype.get = () => { throw new Error("brand get escaped"); };
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

it("captures logs after generated code changes Array methods", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
Array.prototype.push = () => { throw new Error("changed push"); };
Array.prototype.join = () => { throw new Error("changed join"); };
console.log("still", "captured");
return 42;
`
  });

  expect(result).toEqual({
    status: "completed",
    value: 42,
    logs: [{ level: "log", message: "still captured" }]
  });
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

it("bounds generated error messages before they cross RPC", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const message = "🔥".repeat(20_000);
TextEncoder.prototype.encode = () => { throw new Error("changed encode"); };
String.prototype.slice = () => { throw new Error("changed slice"); };
String.prototype.charCodeAt = () => { throw new Error("changed charCodeAt"); };
Math.ceil = () => { throw new Error("changed ceil"); };
throw new Error(message);
`
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR"
  });
  if (!(failure instanceof RunError)) throw failure;
  // Four-byte emoji content truncates to 16380 bytes plus the 3-byte suffix.
  expect(new TextEncoder().encode(failure.message).byteLength).toBe(16_383);
  expect(failure.message).toMatch(/…$/u);
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

it("retains every log at an exact byte-budget fit without a warning", async () => {
  const result = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
console.log("${"a".repeat(20)}");
console.warn("${"b".repeat(5)}");
return 1;
`,
    limits: { maxLogBytes: 25 }
  });

  expect(result.logs).toEqual([
    { level: "log", message: "a".repeat(20) },
    { level: "warn", message: "b".repeat(5) }
  ]);
});

it("appends exactly one truncation warning and continues execution on overflow", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
console.log("aa");
console.log("bb");
console.log("${"c".repeat(30)}");
console.log("ignored after overflow");
console.error("also ignored");
return 42;
`,
    limits: { maxLogBytes: 30 }
  });

  expect(result.value).toBe(42);
  expect(result.logs).toEqual([
    { level: "log", message: "aa" },
    { level: "log", message: "bb" },
    { level: "warn", message: "Console output truncated." }
  ]);
});

it("removes trailing retained entries so the truncation warning fits", async () => {
  const result = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
console.log("aaaa");
console.log("bbbbbb");
console.log("${"c".repeat(25)}");
return 1;
`,
    limits: { maxLogBytes: 30 }
  });

  expect(result.logs).toEqual([
    { level: "log", message: "aaaa" },
    { level: "warn", message: "Console output truncated." }
  ]);
});

it("retains only the warning at the 25-byte minimum log budget", async () => {
  const result = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
console.log("hello");
console.log("${"x".repeat(26)}");
return 1;
`,
    limits: { maxLogBytes: 25 }
  });

  expect(result.logs).toEqual([
    { level: "warn", message: "Console output truncated." }
  ]);
});

it("counts the log budget in UTF-8 bytes rather than characters", async () => {
  // Each fire emoji is four UTF-8 bytes, so seven emoji exceed 25 bytes.
  const result = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
console.log("${"🔥".repeat(7)}");
return 1;
`,
    limits: { maxLogBytes: 25 }
  });

  expect(result.logs).toEqual([
    { level: "warn", message: "Console output truncated." }
  ]);
});

it("returns retained logs on an ordinary terminal failure", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: 'console.log("kept entry"); throw new Error("after logging");'
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR",
    logs: [{ level: "log", message: "kept entry" }]
  });
});

it("maps an oversized final transfer through the platform to RUN_SERIALIZATION_ERROR", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return new ArrayBuffer(33 * 1024 * 1024);"
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_SERIALIZATION_ERROR"
  });
});

it("maps an oversized host argument transfer to RUN_SERIALIZATION_ERROR", async () => {
  let invocations = 0;

  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.store(new ArrayBuffer(33 * 1024 * 1024));",
    hostFunctions: {
      tools: {
        store() {
          invocations++;
          return true;
        }
      }
    }
  }).catch((cause: unknown) => cause);

  // The platform rejects the awaited RPC exchange without attributing which
  // leg exceeded the ceiling, so only the fixed host-call category is stable.
  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_SERIALIZATION_ERROR",
    details: { hostFunction: "tools.store" }
  });
  expect(failure).toBeInstanceOf(RunError);
  expect(["hostFunction.arguments", "hostFunction.result"]).toContain(
    failure instanceof RunError ? failure.details?.path : undefined
  );
  expect(invocations).toBe(0);
});

it("accepts configured cpu and subrequest overrides through the real Loader", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return 7;",
    limits: { cpuMs: 1_000, subRequests: 10 }
  });

  expect(result).toMatchObject({ status: "completed", value: 7 });
});

it("bounds a guest-authored stack to 32 KiB of UTF-8", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
const error = new Error("bounded");
error.stack = "s".repeat(40 * 1024);
throw error;
`
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_EXECUTION_ERROR"
  });
  const stack = failure instanceof RunError ? (failure.stack ?? "") : "";
  // Single-byte content truncates to exactly the 32 KiB boundary.
  expect(new TextEncoder().encode(stack).byteLength).toBe(32 * 1024);
  expect(stack.endsWith("…")).toBe(true);
});

it("captures logs under hostile Array.prototype numeric setters", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
for (let index = 0; index <= 4; index++) {
  Object.defineProperty(Array.prototype, String(index), {
    configurable: true,
    set() { throw new Error("array prototype poison"); }
  });
}
console.log("still", "captured");
return 42;
`
  });

  expect(result.value).toBe(42);
  expect(result.logs).toEqual([{ level: "log", message: "still captured" }]);
});

it("bounds a flood of empty console messages to one truncation warning", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
for (let index = 0; index < 40; index++) console.log("");
return 42;
`,
    limits: { maxLogBytes: 25 }
  });

  expect(result.value).toBe(42);
  expect(result.logs).toEqual([
    { level: "warn", message: "Console output truncated." }
  ]);
});
