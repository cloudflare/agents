declare module "virtual:react-router/server-build" {
  const build: import("react-router").ServerBuild;
  export default build;
}

declare module "virtual:think/entry" {
  const entry: ExportedHandler<import("./src/env").Env>;
  export default entry;
  export const ThinkAgent_Host: typeof import("./agents/host").HostAgent;
}
