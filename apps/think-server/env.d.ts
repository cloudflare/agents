interface Env {
  AI: Ai;
  LOADER: WorkerLoader;
  R2: R2Bucket;
  ThinkServer: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}
