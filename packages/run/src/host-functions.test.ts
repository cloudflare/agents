import { expect, it } from "vitest";
import { run } from "./index";
import type { HostFunctions } from "./run-types";
import { LOCAL_DYNAMIC_WORKER_LOADER } from "./run-test-worker-loader";

function runWithUntrustedHostFunctions(hostFunctions: unknown) {
  return run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return 1;",
    // SAFETY: This public-interface test intentionally supplies malformed runtime input.
    hostFunctions: hostFunctions as HostFunctions
  });
}

function createLoadCountingWorkerLoader(onLoad: () => void): WorkerLoader {
  return {
    get(name, getCode) {
      return LOCAL_DYNAMIC_WORKER_LOADER.get(name, getCode);
    },
    load(code) {
      onLoad();
      return LOCAL_DYNAMIC_WORKER_LOADER.load(code);
    }
  };
}

function defineEnumerableDataProperty(
  target: object,
  property: PropertyKey,
  value: unknown
): object {
  Object.defineProperty(target, property, { enumerable: true, value });
  return target;
}

it.each([
  ["an array", []],
  ["null", null],
  ["a primitive", 1],
  ["a function", () => undefined],
  ["a custom prototype", Object.create({ inherited: true })],
  ["a symbol field", defineEnumerableDataProperty({}, Symbol("hidden"), {})],
  ["a non-enumerable field", Object.defineProperty({}, "tools", { value: {} })],
  ["a non-function leaf", { tools: { lookup: 1 } }],
  ["a third nesting level", { tools: { lookup: { deeper: () => 1 } } }]
])(
  "rejects a host-function container with %s before loading",
  async (_name, hostFunctions) => {
    let loadCount = 0;
    const failure = await run({
      loader: createLoadCountingWorkerLoader(() => loadCount++),
      source: "return 1;",
      // SAFETY: This public-interface test intentionally supplies malformed runtime input.
      hostFunctions: hostFunctions as HostFunctions
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      name: "RunError",
      code: "RUN_INVALID_INPUT",
      details: { path: "hostFunctions" }
    });
    expect(loadCount).toBe(0);
  }
);

it.each([
  ["an array", []],
  ["null", null],
  ["a custom prototype", Object.create({ inherited: true })],
  [
    "a symbol field",
    defineEnumerableDataProperty({}, Symbol("hidden"), () => undefined)
  ],
  [
    "a non-enumerable field",
    Object.defineProperty({}, "lookup", { value: () => undefined })
  ]
])("rejects a host-function namespace with %s", async (_name, namespace) => {
  const failure = await runWithUntrustedHostFunctions({
    tools: namespace
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions.namespace" }
  });
});

it("rejects inherited enumerable host fields", async () => {
  Object.defineProperty(Object.prototype, "inheritedRunHostFunction", {
    configurable: true,
    enumerable: true,
    value: { lookup: () => 1 }
  });
  let invocation: ReturnType<typeof run>;
  try {
    invocation = run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: "return 1;",
      hostFunctions: {}
    });
  } finally {
    Reflect.deleteProperty(Object.prototype, "inheritedRunHostFunction");
  }

  const failure = await invocation.catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions" }
  });
});

it("rejects inherited enumerable symbol host fields", async () => {
  const inheritedSymbol = Symbol("inheritedRunHostFunction");
  Object.defineProperty(Object.prototype, inheritedSymbol, {
    configurable: true,
    enumerable: true,
    value: { lookup: () => 1 }
  });
  let invocation: ReturnType<typeof run>;
  try {
    invocation = run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: "return 1;",
      hostFunctions: {}
    });
  } finally {
    Reflect.deleteProperty(Object.prototype, inheritedSymbol);
  }

  const failure = await invocation.catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions" }
  });
});

it("rejects host accessors without invoking their getters", async () => {
  let getterCalls = 0;
  const hostFunctions = Object.defineProperty({}, "tools", {
    enumerable: true,
    get() {
      getterCalls++;
      return { lookup: () => 1 };
    }
  });

  const failure = await runWithUntrustedHostFunctions(hostFunctions).catch(
    (cause: unknown) => cause
  );

  expect(failure).toMatchObject({
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions" }
  });
  expect(getterCalls).toBe(0);
});

it("rejects namespace accessors without invoking their getters", async () => {
  let getterCalls = 0;
  const namespace = Object.defineProperty({}, "lookup", {
    enumerable: true,
    get() {
      getterCalls++;
      return () => 1;
    }
  });

  const failure = await runWithUntrustedHostFunctions({
    tools: namespace
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions.namespace" }
  });
  expect(getterCalls).toBe(0);
});

it("contains hostile reflection failures while parsing host containers", async () => {
  const reflectionFailure = new Proxy(
    {},
    {
      get() {
        throw new Error("private reflection getter");
      },
      getPrototypeOf() {
        throw reflectionFailure;
      }
    }
  );

  const failure = await runWithUntrustedHostFunctions(reflectionFailure).catch(
    (cause: unknown) => cause
  );

  expect(failure).toMatchObject({
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions" }
  });
  expect(String(failure)).not.toContain("private reflection");
});

it("accepts plain and null-prototype host containers", async () => {
  // SAFETY: The null-prototype containers receive only the typed fields below.
  const nullPrototypeNamespace = Object.create(null) as Record<
    string,
    () => number
  >;
  nullPrototypeNamespace.read = () => 21;
  // SAFETY: This cast is populated only with the typed namespace above.
  const nullPrototypeHostFunctions = Object.create(null) as Record<
    string,
    typeof nullPrototypeNamespace
  >;
  nullPrototypeHostFunctions.tools = nullPrototypeNamespace;

  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.read() * 2;",
    hostFunctions: nullPrototypeHostFunctions
  });

  expect(result.value).toBe(42);
});

it("accepts an empty host-function namespace", async () => {
  const result = await run<string>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return typeof tools;",
    hostFunctions: { tools: {} }
  });

  expect(result.value).toBe("object");
});

it("accepts exact Unicode identifiers and the case-sensitive __Run prefix", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await 工具.café() + await __Run.allowed();",
    hostFunctions: {
      工具: { café: () => 21 },
      __Run: { allowed: () => 21 }
    }
  });

  expect(result.value).toBe(42);
});

it.each([
  "await",
  "class",
  "not-valid",
  "1st",
  "__proto__",
  "prototype",
  "constructor",
  "then",
  "__run",
  "__runInternal"
])("rejects the unsafe namespace name %s before loading", async (namespace) => {
  let loadCount = 0;
  const failure = await run({
    loader: createLoadCountingWorkerLoader(() => loadCount++),
    source: "return 1;",
    hostFunctions: { [namespace]: { lookup: () => 1 } }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions.namespaceName" }
  });
  expect(loadCount).toBe(0);
});

it.each([
  "await",
  "class",
  "not-valid",
  "1st",
  "__proto__",
  "prototype",
  "constructor",
  "then",
  "__run",
  "__runInternal"
])(
  "rejects the unsafe host function name %s before loading",
  async (functionName) => {
    let loadCount = 0;
    const failure = await run({
      loader: createLoadCountingWorkerLoader(() => loadCount++),
      source: "return 1;",
      hostFunctions: { tools: { [functionName]: () => 1 } }
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: "RUN_INVALID_INPUT",
      details: { path: "hostFunctions.functionName" }
    });
    expect(loadCount).toBe(0);
  }
);

it("rejects a child-global namespace before caller source executes", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: 'throw new Error("caller source executed");',
    hostFunctions: { console: { read: () => 1 } }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_INVALID_INPUT",
    details: { path: "hostFunctions.namespace" },
    logs: []
  });
  expect(String(failure)).not.toContain("caller source executed");
});

it("allows a host method whose name matches a child global", async () => {
  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.fetch();",
    hostFunctions: { tools: { fetch: () => 42 } }
  });

  expect(result.value).toBe(42);
});
