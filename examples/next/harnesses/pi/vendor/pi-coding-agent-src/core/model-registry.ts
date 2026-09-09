// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream's ModelRegistry is a class over a ModelRuntime that reads models.json
 * from disk. ExtensionRunner only calls three of its methods, so the vendored
 * tree types it as an interface the harness implements over its own process-local
 * registry.
 *
 * `Provider` is upstream's own pi-ai type. Upstream's overloads take a
 * `ProviderConfigInput` from core/provider-composer.ts (not vendored); the
 * extension-facing `ProviderConfig` from extensions/types.ts is used instead,
 * which is what ExtensionRunner passes in.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "./extensions/types.ts";

export interface ModelRegistry {
	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfig): void;
	unregisterProvider(providerName: string): void;
}
