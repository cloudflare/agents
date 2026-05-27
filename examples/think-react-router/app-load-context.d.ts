import "react-router";

declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Cloudflare.Env;
      ctx: ExecutionContext;
    };
  }
}
