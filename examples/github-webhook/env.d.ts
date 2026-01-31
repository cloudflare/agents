declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "RepoAgent";
  }
  interface Env {
    GITHUB_WEBHOOK_SECRET: string;
    RepoAgent: DurableObjectNamespace<import("./src/server").RepoAgent>;
  }
}
interface Env extends Cloudflare.Env {}
type StringifyValues<EnvType extends Record<string, unknown>> = {
  [Binding in keyof EnvType]: EnvType[Binding] extends string
    ? EnvType[Binding]
    : string;
};
declare namespace NodeJS {
  interface ProcessEnv extends StringifyValues<
    Pick<Cloudflare.Env, "GITHUB_WEBHOOK_SECRET">
  > {}
}
