declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    PLANETSCALE_HOST: string;
    PLANETSCALE_USERNAME: string;
    PLANETSCALE_PASSWORD: string;
  }
}
interface Env extends Cloudflare.Env {}
