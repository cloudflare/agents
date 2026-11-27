import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { ThinkConfigStore } from "../../config-store";

/**
 * The `think_config` capability on a minimal Durable Object, with no Think:
 * its own tests reach the store here, on both test configs.
 */
export class ThinkConfigStoreProbe extends DurableObject<Cloudflare.Env> {
  readonly config = new ThinkConfigStore();
  readonly lifecycle = Lifecycle.install(this).use(this.config);

  /** Start the Lifecycle, which starts the store (its table and its lift). */
  async start(): Promise<void> {
    await this.lifecycle.start();
  }
}
