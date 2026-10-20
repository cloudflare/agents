declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader;
    HOST: DurableObjectNamespace<import("./worker").BackendTestHost>;
  }
}
