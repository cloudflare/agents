interface Env {
  LOADER: WorkerLoader;
  OPENAI_API_KEY: string;
  Think: DurableObjectNamespace<import("../server").Think>;
}
