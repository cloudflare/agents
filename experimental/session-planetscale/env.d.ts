declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    HYPERDRIVE: Hyperdrive;
  }
}
interface Env extends Cloudflare.Env {}
