import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../../vendor/pi-coding-agent-src/core/model-registry.ts";
import type { ProviderConfig } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { PiModelRegistry } from "../../providers/models";

/**
 * A provider an extension registered by name and configuration rather than
 * as a pi-ai provider object.
 */
export type PiExtensionProviderRegistration = {
  readonly name: string;
  readonly config: ProviderConfig;
};

/** The registry the extension runtime exposes, plus its process-local part. */
export interface PiExtensionModelRegistry extends ModelRegistry {
  /** Configuration-form registrations recorded during this isolate's life. */
  registrations(): readonly PiExtensionProviderRegistration[];
}

/**
 * Bridge pi's three-method `ModelRegistry` onto the harness's model registry.
 *
 * Native registration is a straight `setProvider`: an extension that builds a
 * pi-ai provider gets a provider the harness can resolve models from
 * immediately. The configuration form is a process-local overlay instead:
 * turning a `ProviderConfig` into a pi-ai provider needs upstream's provider
 * composer, which reads `models.json` from disk and is not vendored. Those
 * registrations are recorded and readable — a host can compose them itself —
 * but they add no resolvable models on their own. Unregistering likewise only
 * drops the overlay entry; pi-ai's registry has no removal.
 */
export function createExtensionModelRegistry(
  models: PiModelRegistry
): PiExtensionModelRegistry {
  const overlay = new Map<string, ProviderConfig>();
  function registerProvider(provider: Provider): void;
  function registerProvider(providerName: string, config: ProviderConfig): void;
  function registerProvider(
    providerOrName: Provider | string,
    config?: ProviderConfig
  ): void {
    if (typeof providerOrName !== "string") {
      models.setProvider(providerOrName);
      return;
    }
    if (!config) {
      throw new Error(
        `Provider config is required when registering ${JSON.stringify(providerOrName)} by name`
      );
    }
    overlay.set(providerOrName, config);
  }
  return {
    registerProvider,
    unregisterProvider: (providerName: string) => {
      overlay.delete(providerName);
    },
    registrations: () =>
      [...overlay].map(([name, config]) => ({ name, config }))
  };
}
