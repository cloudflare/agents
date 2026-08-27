import { expect, it } from "vitest";
import { run } from "./index";

type RecordingLoaderBehavior = {
  readonly response?: unknown;
  readonly loadError?: Error;
  readonly entrypointError?: Error;
  readonly evaluateError?: Error;
  readonly entrypointDisposeError?: Error;
  readonly workerDisposeError?: Error;
};

function createRecordingLoader(behavior: RecordingLoaderBehavior = {}): {
  readonly loader: WorkerLoader;
  readonly events: string[];
  readonly loadedCode: WorkerLoaderWorkerCode[];
} {
  const events: string[] = [];
  const loadedCode: WorkerLoaderWorkerCode[] = [];
  const entrypoint = {
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
  };
  const worker = {
    getEntrypoint(): typeof entrypoint {
      if (behavior.entrypointError) throw behavior.entrypointError;
      return entrypoint;
    },
    [Symbol.dispose](): void {
      events.push("worker");
      if (behavior.workerDisposeError) throw behavior.workerDisposeError;
    }
  };
  const loader: WorkerLoader = {
    get(): WorkerStub {
      throw new Error("Recording Loader does not implement get().");
    },
    load(code): WorkerStub {
      if (behavior.loadError) throw behavior.loadError;
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

it("classifies Loader failures without losing the trusted cause", async () => {
  const cause = new Error("Loader unavailable");
  const recording = createRecordingLoader({ loadError: cause });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_WORKER_ERROR",
    cause
  });
  expect(recording.events).toEqual([]);
});

it("rejects a malformed child protocol response after disposal", async () => {
  const recording = createRecordingLoader({
    response: { status: "unexpected" }
  });

  const failure = await run({
    loader: recording.loader,
    source: "return 42;"
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({
    name: "RunError",
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
  }).catch((error: unknown) => error);

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
