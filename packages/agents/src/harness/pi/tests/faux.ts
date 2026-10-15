import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";

/** pi-ai models holding only the faux provider. */
export function fauxModels(provider: Provider) {
  const models = createModels();
  models.setProvider(provider);
  return models;
}

/** No generation retries, so a failing test fails at once. */
export const NO_RETRY = { enabled: false, maxRetries: 0, baseDelayMs: 0 };

/**
 * Settings for every test harness: no retries, and no idle caches. Pi keeps
 * idle caches behind timers (ten minutes by default), and a pending timer
 * keeps a Durable Object from being evicted, so `evictDurableObject` would
 * wait on them.
 */
export const TEST_SETTINGS = {
  retry: NO_RETRY,
  contextRetentionMs: 0,
  documentRetentionMs: 0
};
