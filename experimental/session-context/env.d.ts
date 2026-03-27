/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "ChatAgent";
  }
  interface Env {
    AI: Ai;
    KNOWLEDGE: import("agents/experimental/memory/session").AiSearchBinding;
    ChatAgent: DurableObjectNamespace<import("./src/server").ChatAgent>;
  }
}
interface Env extends Cloudflare.Env {}
