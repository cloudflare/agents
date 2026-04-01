/* eslint-disable */
// Hand-written env.d.ts — regenerate with `wrangler types env.d.ts --include-runtime false`
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "SandboxChatAgent" | "Sandbox";
  }
  interface Env {
    AI: Ai;
    Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
    SandboxChatAgent: DurableObjectNamespace<
      import("./src/server").SandboxChatAgent
    >;
    BACKUP_BUCKET: R2Bucket;
    BACKUP_BUCKET_NAME: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_KEY: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}

interface Env extends Cloudflare.Env {}
