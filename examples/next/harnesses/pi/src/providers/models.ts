import {
  createModels as createPiModels,
  type Model,
  type MutableModels,
  type Provider
} from "@earendil-works/pi-ai";
import type { PiModel, PiModelIdentity } from "../harness/types";

/**
 * One pi-ai provider. Construct providers with pi-ai's own factories (each
 * one importable from pi-ai's provider subpaths so a bundler
 * resolves only the vendor SDKs a provider actually in use needs) or with
 * {@link workersAI} for the Workers AI binding.
 */
export type PiProvider = object;

/** Options for {@link createModels}. */
export type CreateModelsOptions = {
  /**
   * Values pi-ai reads credentials from, by their conventional names
   * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLOUDFLARE_API_KEY` with
   * `CLOUDFLARE_ACCOUNT_ID`, …). Pass the Worker `env` so secrets resolve.
   */
  readonly env?: object;
  /**
   * Providers to register, upserted by provider id. A registry with none
   * registered is valid but resolves no models — register at least
   * {@link workersAI} or one pi-ai provider factory.
   */
  readonly providers?: readonly PiProvider[];
};

/** Pi's model registry with the lookups the harness and hosts need. */
export interface PiModelRegistry {
  /** Resolve one catalog model, or undefined when the provider lacks it. */
  getModel(provider: string, modelId: string): PiModel | undefined;
  /** Known models of one provider, or of every provider. */
  getModels(provider?: string): readonly PiModel[];
  /** Providers with configured credentials. */
  getProviders(): readonly { readonly id: string; readonly name: string }[];
  /** Add or replace a provider by id. */
  setProvider(provider: PiProvider): void;
}

function envLookup(env: object | undefined) {
  return async (name: string): Promise<string | undefined> => {
    if (!env) return undefined;
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
}

/**
 * Create pi's model registry for a Worker.
 *
 * The registry starts empty: register {@link workersAI} for the zero-config
 * binding-backed provider, or a pi-ai provider factory imported from its own
 * pi-ai provider subpath (`anthropic`, `openai`, etc.) for that
 * provider's hosted API. Importing only the subpaths a Worker uses keeps a
 * bundler from having to resolve every pi-ai provider's vendor SDK — some
 * (Anthropic's, notably) ship Node-only tooling beyond what `nodejs_compat`
 * covers. The pi-ai root package exposes its complete built-in
 * catalog in one call for a build pipeline that can resolve all of them.
 */
export function createModels(
  options: CreateModelsOptions = {}
): PiModelRegistry {
  const models: MutableModels = createPiModels({
    authContext: {
      env: envLookup(options.env),
      fileExists: async () => false
    }
  });
  for (const provider of options.providers ?? []) {
    // SAFETY: PiProvider values are pi-ai Provider objects constructed by
    // pi-ai factories or by workersAI(); the opaque public type hides the
    // pinned upstream shape.
    models.setProvider(provider as Provider);
  }
  // SAFETY: MutableModels satisfies PiModelRegistry structurally; Model<Api>
  // values carry the id/provider/api fields PiModel names.
  return models as unknown as PiModelRegistry;
}

/** Resolve a model reference against a registry, throwing when unknown. */
export function resolveModel(
  models: PiModelRegistry,
  model: PiModel | PiModelIdentity
): PiModel {
  if ("id" in model) return model;
  const resolved = models.getModel(model.provider, model.modelId);
  if (!resolved) {
    throw new Error(
      `Unknown pi model ${JSON.stringify(model.modelId)} for provider ${JSON.stringify(model.provider)}`
    );
  }
  return resolved;
}

export type { Model as UpstreamModel };
