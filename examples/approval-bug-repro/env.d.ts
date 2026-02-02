declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "ApprovalBugAgent";
  }
  interface Env {
    ApprovalBugAgent: DurableObjectNamespace<
      import("./src/server").ApprovalBugAgent
    >;
  }
}
interface Env extends Cloudflare.Env {}
