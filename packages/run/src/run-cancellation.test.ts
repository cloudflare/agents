import { expect, it } from "vitest";
import { getHostFunctionContext, run } from "./index";
import { createRecordingLoader } from "./run-test-recording-loader";
import { LOCAL_DYNAMIC_WORKER_LOADER } from "./run-test-worker-loader";

// A bare forever-pending promise trips workerd's hang detection, so the
// pending source holds a long scheduled timer instead.
const RUN_PENDING_SOURCE =
  "await new Promise((resolve) => setTimeout(resolve, 60000));";

it("rejects an already-aborted signal without using the Loader", async () => {
  const recording = createRecordingLoader();
  const controller = new AbortController();
  const reason = new Error("stop before start");
  controller.abort(reason);

  await expect(
    run({
      loader: recording.loader,
      source: "return 42;",
      signal: controller.signal
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_ABORTED",
    cause: reason
  });
  expect(recording.loadedCode).toEqual([]);
});

it("rejects with RUN_ABORTED and the trusted reason on an active abort", async () => {
  const controller = new AbortController();
  const reason = new Error("stop now");
  const pending = run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: RUN_PENDING_SOURCE,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(reason), 20);

  await expect(pending).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_ABORTED",
    cause: reason
  });
});

it("rejects with RUN_TIMEOUT and empty best-effort logs on wall timeout", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `console.log("before hanging"); ${RUN_PENDING_SOURCE}`,
    limits: { timeoutMs: 50 }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_TIMEOUT",
    details: { limit: "timeoutMs", allowed: 50 },
    logs: []
  });
});

it("aborts active host signals with the terminal RunError without waiting for host promises", async () => {
  let capturedSignal: AbortSignal | undefined;
  let releaseHost: (() => void) | undefined;

  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.hang();",
    limits: { timeoutMs: 100 },
    hostFunctions: {
      tools: {
        hang() {
          capturedSignal = getHostFunctionContext().signal;
          return new Promise<void>((resolve) => {
            releaseHost = resolve;
          });
        }
      }
    }
  }).catch((cause: unknown) => cause);

  expect(failure).toMatchObject({ name: "RunError", code: "RUN_TIMEOUT" });
  expect(capturedSignal?.aborted).toBe(true);
  expect(capturedSignal?.reason).toBe(failure);

  releaseHost?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

it("contains a late host rejection after the terminal failure", async () => {
  let rejectHost: ((reason: Error) => void) | undefined;

  await expect(
    run({
      loader: LOCAL_DYNAMIC_WORKER_LOADER,
      source: "return await tools.hang();",
      limits: { timeoutMs: 50 },
      hostFunctions: {
        tools: {
          hang() {
            return new Promise<never>((_resolve, reject) => {
              rejectHost = reject;
            });
          }
        }
      }
    })
  ).rejects.toMatchObject({ name: "RunError", code: "RUN_TIMEOUT" });

  rejectHost?.(new Error("late host failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

it("ignores cancellation after completion", async () => {
  const controller = new AbortController();
  let hostSignal: AbortSignal | undefined;

  const result = await run<number>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.ping();",
    signal: controller.signal,
    hostFunctions: {
      tools: {
        ping() {
          hostSignal = getHostFunctionContext().signal;
          return 1;
        }
      }
    }
  });
  controller.abort(new Error("too late"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(result).toMatchObject({ status: "completed", value: 1 });
  expect(hostSignal?.aborted).toBe(false);
});

it.each([
  ["caller abort", { signalAfterMs: 10 }, "RUN_ABORTED"],
  ["wall timeout", { timeoutMs: 20 }, "RUN_TIMEOUT"]
] as const)(
  "disposes entrypoint before Worker on %s",
  async (_name, behavior, code) => {
    const recording = createRecordingLoader({ evaluatePending: true });
    const controller = new AbortController();
    if ("signalAfterMs" in behavior) {
      setTimeout(() => controller.abort(), behavior.signalAfterMs);
    }

    await expect(
      run({
        loader: recording.loader,
        source: "return 42;",
        signal: controller.signal,
        ...("timeoutMs" in behavior
          ? { limits: { timeoutMs: behavior.timeoutMs } }
          : {})
      })
    ).rejects.toMatchObject({ name: "RunError", code });
    expect(recording.events).toEqual(["entrypoint", "worker"]);
  }
);

it("does not let disposal failures mask a terminal cancellation", async () => {
  const recording = createRecordingLoader({
    evaluatePending: true,
    entrypointDisposeError: new Error("entrypoint disposal failed"),
    workerDisposeError: new Error("worker disposal failed")
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  await expect(
    run({
      loader: recording.loader,
      source: "return 42;",
      signal: controller.signal
    })
  ).rejects.toMatchObject({ name: "RunError", code: "RUN_ABORTED" });
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});

it("prefers a synchronous caller abort during loading over the Loader failure", async () => {
  const controller = new AbortController();
  const reason = new Error("abort during load");
  const loader: WorkerLoader = {
    get(): WorkerStub {
      throw new Error("unused");
    },
    load(): WorkerStub {
      controller.abort(reason);
      throw new Error("Loader failed after abort.");
    }
  };

  await expect(
    run({ loader, source: "return 42;", signal: controller.signal })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_ABORTED",
    cause: reason
  });
});

it("aborts an active host signal with the RUN_ABORTED terminal error", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  let hostStarted: (() => void) | undefined;
  const hostRunning = new Promise<void>((resolve) => {
    hostStarted = resolve;
  });

  const pending = run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: "return await tools.hang();",
    signal: controller.signal,
    hostFunctions: {
      tools: {
        hang() {
          capturedSignal = getHostFunctionContext().signal;
          hostStarted?.();
          return new Promise(() => {});
        }
      }
    }
  });
  await hostRunning;
  controller.abort(new Error("caller stopped"));

  const failure = await pending.catch((cause: unknown) => cause);
  expect(failure).toMatchObject({ name: "RunError", code: "RUN_ABORTED" });
  expect(capturedSignal?.aborted).toBe(true);
  expect(capturedSignal?.reason).toBe(failure);
});

it("prefers a synchronous caller abort during loading over a completed evaluation", async () => {
  const recording = createRecordingLoader();
  const controller = new AbortController();
  const reason = new Error("abort during successful load");
  const abortingLoader: WorkerLoader = {
    get(): WorkerStub {
      throw new Error("unused");
    },
    load(code): WorkerStub {
      controller.abort(reason);
      return recording.loader.load(code);
    }
  };

  await expect(
    run({
      loader: abortingLoader,
      source: "return 42;",
      signal: controller.signal
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_ABORTED",
    cause: reason
  });
  expect(recording.events).toEqual(["worker"]);
  expect(recording.evaluateArgs).toEqual([]);
});

it("prefers a synchronous caller abort during entrypoint acquisition over evaluation", async () => {
  const controller = new AbortController();
  const reason = new Error("abort during entrypoint acquisition");
  const recording = createRecordingLoader({
    getEntrypointHook: () => controller.abort(reason)
  });

  await expect(
    run({
      loader: recording.loader,
      source: "return 42;",
      signal: controller.signal
    })
  ).rejects.toMatchObject({
    name: "RunError",
    code: "RUN_ABORTED",
    cause: reason
  });
  expect(recording.evaluateArgs).toEqual([]);
  expect(recording.events).toEqual(["entrypoint", "worker"]);
});
