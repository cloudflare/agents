/** Configurable failure and timing behavior for one recording Loader fake. */
export type RecordingLoaderBehavior = {
  readonly response?: unknown;
  readonly evaluatePending?: boolean;
  readonly loadError?: unknown;
  readonly entrypointError?: Error;
  readonly getEntrypointHook?: () => void;
  readonly evaluateError?: Error;
  readonly entrypointDisposeError?: Error;
  readonly workerDisposeError?: Error;
  readonly disposeInspection?: "presence" | "lookup";
};

/**
 * Create a faithful in-memory Worker Loader fake for lifecycle observations
 * that a real Loader cannot expose: disposal order, disposal timing, loaded
 * configuration, and raw entrypoint protocol traffic.
 */
export function createRecordingLoader(behavior: RecordingLoaderBehavior = {}) {
  const events: string[] = [];
  const loadedCode: WorkerLoaderWorkerCode[] = [];
  const evaluateArgs: unknown[][] = [];
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
    async evaluate(...args: unknown[]): Promise<unknown> {
      evaluateArgs.push(args);
      if (behavior.evaluatePending) return new Promise<never>(() => {});
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
      behavior.getEntrypointHook?.();
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

  return { loader, events, loadedCode, evaluateArgs };
}
