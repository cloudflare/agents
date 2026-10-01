import {
  createModels as createPiModels,
  type MutableModels,
  type Provider
} from "@earendil-works/pi-ai/models";

/** Options for {@link createModels}. */
export type CreateModelsOptions = {
  /**
   * Values pi-ai reads credentials from, by their conventional names
   * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Pass the Worker `env` so
   * secrets resolve.
   */
  readonly env?: object;
  /** Providers to register, such as {@link workersAI} or pi-ai's faux. */
  readonly providers?: readonly Provider[];
};

function envLookup(env: object | undefined) {
  return async (name: string): Promise<string | undefined> => {
    if (!env) return undefined;
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
}

/**
 * pi's model registry for a Worker. It starts empty: register
 * {@link workersAI} for the binding-backed provider, or a pi-ai provider
 * factory imported from its own subpath, so the bundle only pulls in the
 * vendor SDKs a provider in use needs.
 */
export function createModels(options: CreateModelsOptions = {}): MutableModels {
  const models = createPiModels({
    authContext: { env: envLookup(options.env), fileExists: async () => false }
  });
  for (const provider of options.providers ?? []) models.setProvider(provider);
  return models;
}
