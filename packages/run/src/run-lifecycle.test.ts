import { expect, it } from "vitest";
import { run } from "./index";
import { createRecordingLoader } from "./run-test-recording-loader";

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
    "serialization failure",
    {
      response: {
        status: "failed",
        error: {
          name: "RunSerializationError",
          message: "Run data could not be serialized.",
          code: "RUN_SERIALIZATION_ERROR",
          path: "result"
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

it("maps a detached-call child record to RUN_DETACHED_HOST_FUNCTION after disposal", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: {
        name: "RunDetachedHostFunctionError",
        message: "private child detail",
        code: "RUN_DETACHED_HOST_FUNCTION",
        hostFunction: "tools.slow"
      },
      logs: []
    }
  });

  await expect(
    run({ loader: recording.loader, source: "return 42;" })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_DETACHED_HOST_FUNCTION",
    message: "Generated code returned before a host function call settled.",
    details: { hostFunction: "tools.slow" }
  });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("computes host-call limit details from parent-validated limits only", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: {
        name: "RunHostFunctionLimitError",
        message: "private child detail",
        code: "RUN_HOST_FUNCTION_LIMIT",
        hostFunction: "tools.ping",
        limit: "maxHostFunctionCalls"
      },
      logs: []
    }
  });

  await expect(
    run({
      loader: recording.loader,
      source: "return 42;",
      limits: { maxHostFunctionCalls: 5 }
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_HOST_FUNCTION_LIMIT",
    message: "Host function call limit exceeded.",
    details: {
      hostFunction: "tools.ping",
      limit: "maxHostFunctionCalls",
      observed: 6,
      allowed: 5
    }
  });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("rejects a child limit record with an unrecognized limit name", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: {
        name: "RunHostFunctionLimitError",
        message: "private child detail",
        code: "RUN_HOST_FUNCTION_LIMIT",
        hostFunction: "tools.ping",
        limit: "maxSourceBytes"
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
});

it("rejects a plain child diagnostic carrying an unexpected limit field", async () => {
  const recording = createRecordingLoader({
    response: {
      status: "failed",
      error: {
        name: "Error",
        message: "boom",
        limit: "maxHostFunctionCalls"
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
});

it.each([
  ["Worker exceeded CPU time limit.", "cpuMs"],
  ["Too many subrequests.", "subRequests"]
] as const)(
  "maps the platform failure %j to RUN_RESOURCE_LIMIT",
  async (message, limit) => {
    const cause = new Error(message);
    const recording = createRecordingLoader({ evaluateError: cause });

    await expect(
      run({ loader: recording.loader, source: "return 42;" })
    ).rejects.toMatchObject({
      name: "RunError",
      code: "RUN_RESOURCE_LIMIT",
      cause,
      details: { limit }
    });
    expect(recording.events).toEqual(["entrypoint", "worker"]);
  }
);
