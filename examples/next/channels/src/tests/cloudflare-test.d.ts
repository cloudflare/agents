import type { PiChannelsTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      PI_CHANNELS_TEST: DurableObjectNamespace<PiChannelsTestObject>;
    }
  }
}

export {};
