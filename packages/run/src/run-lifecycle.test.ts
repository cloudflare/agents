import { expect, it } from "vitest";
import { run } from "./index";

type RecordingLoaderBehavior = {
  readonly response?: unknown;
  readonly loadError?: unknown;
  readonly entrypointError?: Error;
  readonly evaluateError?: Error;
  readonly entrypointDisposeError?: Error;
  readonly workerDisposeError?: Error;
  readonly disposeInspection?: "presence" | "lookup";
};

function createRecordingLoader(behavior: RecordingLoaderBehavior = {}) {
  const events: string[] = [];
  const loadedCode: WorkerLoaderWorkerCode[] = [];
  const failDisposeInspection = <Resource extends object>(
    resource: Resource
  ): Resource =>
    behavior.disposeInspection
      ? new Proxy(resource, {
          get(target, property, receiver) {
            if (
              behavior.disposeInspection === "lookup" &&
              property === Symbol.dispose
            ) {
              throw new Error("Disposal lookup failed.");
            }
            return Reflect.get(target, property, receiver);
          },
          has(target, property) {
            if (
              behavior.disposeInspection === "presence" &&
              property === Symbol.dispose
            ) {
              throw new Error("Disposal presence check failed.");
            }
            return Reflect.has(target, property);
          }
        })
      : resource;
  const entrypoint = failDisposeInspection({
    async evaluate(): Promise<unknown> {
      if (behavior.evaluateError) throw behavior.evaluateError;
      return (
        behavior.response ?? {
          status: "completed",
          value: 42,
          logs: []
        }
      );
    },
    [Symbol.dispose](): void {
      events.push("entrypoint");
      if (behavior.entrypointDisposeError) {
        throw behavior.entrypointDisposeError;
      }
    }
  });
  const worker = failDisposeInspection({
    getEntrypoint(): typeof entrypoint {
      if (behavior.entrypointError) throw behavior.entrypointError;
      return entrypoint;
    },
    [Symbol.dispose](): void {
      events.push("worker");
      if (behavior.workerDisposeError) throw behavior.workerDisposeError;
    }
  });
  const loader: WorkerLoader = {
    get(): WorkerStub {
      throw new Error("Recording Loader does not implement get().");
    },
    load(code): WorkerStub {
      if (behavior.loadError !== undefined) throw behavior.loadError;
      loadedCode.push(code);
      // SAFETY: This recording Worker implements every WorkerStub operation Run uses plus its native disposal contract.
      return worker as unknown as WorkerStub;
    }
  };

  return { loader, events, loadedCode };
}

it("loads exactly the package-owned child configuration", async () => {
  const recording = createRecordingLoader();

  await run({ loader: recording.loader, source: "return 42;" });

  expect(recording.loadedCode).toHaveLength(1);
  const [code] = recording.loadedCode;
  expect(code).toBeDefined();
  expect(code).toMatchObject({
    compatibilityDate: "2026-08-27",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "executor.js",
    env: undefined,
    globalOutbound: null,
    limits: { cpuMs: 5_000, subRequests: 256 }
  });
  expect(Object.keys(code?.modules ?? {}).sort()).toEqual([
    "executor.js",
    "run.js"
  ]);
  expect(code?.modules["run.js"]).toBe(
    "export default async function __runUser__() {\nreturn 42;\n}"
  );
});

it.each([
  ["success", {}, ["entrypoint", "worker"]],
  [
    "generated failure",
    {
      response: {
        status: "failed",
        error: { name: "Error", message: "boom" },
        logs: []
      }
    },
    ["entrypoint", "worker"]
  ],
  [
    "host failure",
    {
      response: {
        status: "failed",
        error: {
          name: "RunHostFunctionError",
          message: "Host function failed.",
          code: "RUN_HOST_FUNCTION_ERROR"
        },
        logs: []
      }
    },
    ["entrypoint", "worker"]
  ],
  [
    "evaluation failure",
    { evaluateError: new Error("RPC failed") },
    ["entrypoint", "worker"]
  ],
  [
    "entrypoint acquisition failure",
    { entrypointError: new Error("No entrypoint") },
    ["worker"]
  ]
] as const)(
  "disposes entrypoint before Worker after %s",
  async (_name, behavior, expectedEvents) => {
    const recording = createRecordingLoader(behavior);

    await run({ loader: recording.loader, source: "return 42;" }).catch(
      () => undefined
    );

    expect(recording.events).toEqual(expectedEvents);
  }
);

it("rejects source that escapes the async function body before loading", async () => {
  const recording = createRecordingLoader();

  const failure = await run({
    loader: recording.loader,
    source: `}
console.log("This must not run during module initialization.");
if (true) {`
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_COMPILE_ERROR"
  });
  expect(recording.loadedCode).toEqual([]);
});

it("classifies Loader failures without losing the trusted cause", async () => {
  const cause = new Error("Loader unavailable");
  const recording = createRecordingLoader({ loadError: cause });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((caught: unknown) => caught);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_WORKER_ERROR",
    cause
  });
  expect(recording.events).toEqual([]);
});

it("contains failures while inspecting Loader error diagnostics", async () => {
  const diagnosticFailure = new Error("Diagnostic getter failed.");
  const cause = Object.defineProperty({}, "name", {
    get() {
      throw diagnosticFailure;
    }
  });
  const recording = createRecordingLoader({ loadError: cause });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((caught: unknown) => caught);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_WORKER_ERROR",
    cause
  });
  expect(failure).not.toBe(diagnosticFailure);
});

it("rejects a malformed child protocol response after disposal", async () => {
  const recording = createRecordingLoader({
    response: { status: "unexpected" }
  });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_WORKER_ERROR",
    message: "Dynamic Worker returned an invalid response."
  });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("maps a package-owned child protocol failure without exposing its message", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: {
        name: "RunWorkerProtocolError",
        message: "private protocol detail",
        code: "RUN_WORKER_ERROR",
        hostFunction: "tools.read"
      },
      logs: []
    }
  });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_WORKER_ERROR",
    message: "Dynamic Worker host protocol failed.",
    details: { hostFunction: "tools.read" }
  });
  expect(String(failure)).not.toContain("private protocol detail");
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("rejects an unrecognized child error-detail path", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: {
        name: "RunSerializationError",
        message: "private path detail",
        code: "RUN_SERIALIZATION_ERROR",
        path: "private.host.payload"
      },
      logs: []
    }
  });

  await expect(
    run({ loader: recording.loader, source: "return 42;" })
  ).rejects.toMatchObject({
    code: "RUN_WORKER_ERROR",
    message: "Dynamic Worker returned an invalid response."
  });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("contains a child protocol response that throws during inspection", async () => {
  const protocolFailure = new Error("protocol getter failed");
  const recording = createRecordingLoader({
    response: new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") return undefined;
          throw protocolFailure;
        }
      }
    )
  });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_WORKER_ERROR",
    cause: protocolFailure
  });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("does not let disposal failures mask an execution failure", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: { name: "Error", message: "execution failed" },
      logs: []
    },
    entrypointDisposeError: new Error("entrypoint disposal failed"),
    workerDisposeError: new Error("worker disposal failed")
  });

  await expect(
    run({ loader: recording.loader, source: "throw new Error();" })
  ).rejects.toMatchObject({
    code: "RUN_EXECUTION_ERROR",
    message: "execution failed"
  });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("does not let disposal failures mask a completed result", async () => {
  const recording = createRecordingLoader({
    entrypointDisposeError: new Error("entrypoint disposal failed"),
    workerDisposeError: new Error("worker disposal failed")
  });

  await expect(
    run<number>({ loader: recording.loader, source: "return 42;" })
  ).resolves.toMatchObject({ status: "completed", value: 42 });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it.each([
  ["presence", ["entrypoint", "worker"]],
  ["lookup", []]
] as const)(
  "does not let disposal %s failures mask a completed result",
  async (disposeInspection, expectedEvents) => {
    const recording = createRecordingLoader({ disposeInspection });

    await expect(
      run<number>({ loader: recording.loader, source: "return 42;" })
    ).resolves.toMatchObject({ status: "completed", value: 42 });
    expect(recording.events).toEqual(expectedEvents);
  }
);
