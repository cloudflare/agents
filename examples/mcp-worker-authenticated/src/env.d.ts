declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    MCP_RESOURCE: string;
  }
}

interface Env extends Cloudflare.Env {}
