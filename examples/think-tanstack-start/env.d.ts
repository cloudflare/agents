declare module "virtual:think/entry" {
  const entry: ExportedHandler<import("./src/env").Env>;
  export default entry;
  export const ThinkAgent_Host: typeof import("./agents/host").HostAgent;
}

declare namespace Cloudflare {
  interface Env {
    ThinkAgent_Host: import("./src/env").Env["ThinkAgent_Host"];
  }
}
