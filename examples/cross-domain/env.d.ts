declare namespace Cloudflare {
  interface Env {
    MyAgent: DurableObjectNamespace<import("./src/server").MyAgent>;
  }
}
