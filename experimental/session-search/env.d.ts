declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "SearchAgent";
  }
  interface Env {
    AI: Ai;
    SearchAgent: DurableObjectNamespace<import("./src/server").SearchAgent>;
  }
}
interface Env extends Cloudflare.Env {}
