import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../../vendor/pi-coding-agent-src/core/model-registry.ts";
import type { ProviderConfig } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { PiModelRegistry, PiProvider } from "../../providers/models";

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
 * but they add no resolvable models on their own.
 *
 * One name, one registration, either form: registering over a name replaces
 * whatever it held, and `unregisterProvider` removes both the overlay entry
 * and the pi-ai provider. A registration that survived its unregistration
 * would keep resolving models an extension had withdrawn — the case a
 * provider is unregistered for is usually that it stopped working.
 *
 * Only what an extension registered here is removable. The providers the host
 * configured the registry with are not the extension surface's to withdraw:
 * unregistering one would take the lane's own model away. An extension that
 * registers over a host provider's id shadows it for as long as its own
 * registration stands — unregistering puts the host's provider back rather
 * than leaving the id unresolvable. Either form shadows: a configuration
 * registration that left the host's provider resolvable would go on serving
 * models from the provider the extension replaced.
 */
export function createExtensionModelRegistry(
  models: PiModelRegistry
): PiExtensionModelRegistry {
  const overlay = new Map<string, ProviderConfig>();
  /** Names this surface registered pi-ai providers under. */
  const native = new Set<string>();
  /** Host providers an extension registered over, by the id it took. */
  const displaced = new Map<string, PiProvider>();
  function registerProvider(provider: Provider): void;
  function registerProvider(providerName: string, config: ProviderConfig): void;
  function registerProvider(
    providerOrName: Provider | string,
    config?: ProviderConfig
  ): void {
    if (typeof providerOrName !== "string") {
      const id = providerOrName.id;
      release(id);
      captureHost(id);
      models.setProvider(providerOrName);
      native.add(id);
      return;
    }
    if (!config) {
      throw new Error(
        `Provider config is required when registering ${JSON.stringify(providerOrName)} by name`
      );
    }
    // Both forms take the id outright. The configuration form resolves no
    // models of its own, so a pi-ai provider left under the id would keep
    // serving the registration it replaced — the host's as much as this
    // surface's own, and an extension that registered over a broken host
    // provider would find it still answering.
    release(providerOrName);
    captureHost(providerOrName);
    overlay.set(providerOrName, config);
  }
  /**
   * Take `providerName` away from the host provider holding it, remembering
   * that provider so the id can be handed back when the registration goes.
   *
   * Only ever called with the id already released, so whatever `models` holds
   * here is the host's, never this surface's.
   */
  function captureHost(providerName: string): void {
    const previous = models.getProvider(providerName);
    if (previous === undefined) return;
    displaced.set(providerName, previous);
    models.deleteProvider(providerName);
  }
  /**
   * Give up whatever this surface holds under `providerName`, in either form,
   * and put back the host provider the registration displaced.
   *
   * An id this surface introduced goes away with it; one it took over from
   * the host goes back to the host rather than being left unresolvable.
   */
  function release(providerName: string): void {
    const hadOverlay = overlay.delete(providerName);
    const hadNative = native.delete(providerName);
    if (!hadOverlay && !hadNative) return;
    const previous = displaced.get(providerName);
    displaced.delete(providerName);
    if (previous !== undefined) {
      models.setProvider(previous);
      return;
    }
    if (hadNative) models.deleteProvider(providerName);
  }
  return {
    registerProvider,
    unregisterProvider: release,
    registrations: () =>
      [...overlay].map(([name, config]) => ({ name, config }))
  };
}
