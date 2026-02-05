interface Env {
  LOADER: WorkerLoader;
  OPENAI_API_KEY: string;
  Coder: DurableObjectNamespace<import("../server").Coder>;
}
