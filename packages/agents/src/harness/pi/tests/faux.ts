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
