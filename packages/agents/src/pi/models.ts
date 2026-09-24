import {
  createModels as createPiModels,
  type Model,
  type MutableModels,
  type Provider
} from "@earendil-works/pi-ai";
import type { PiModel, PiModelIdentity } from "./types";

export type PiProvider = object;

export type CreateModelsOptions = {
  readonly env?: object;

  readonly providers?: readonly PiProvider[];
};

export interface PiModelRegistry {
  getModel(provider: string, modelId: string): PiModel | undefined;

  getModels(provider?: string): readonly PiModel[];

  getProviders(): readonly { readonly id: string; readonly name: string }[];

  setProvider(provider: PiProvider): void;
}

function envLookup(env: object | undefined) {
  return async (name: string): Promise<string | undefined> => {
    if (!env) return undefined;
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
}

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
    models.setProvider(provider as Provider);
  }
  return models as unknown as PiModelRegistry;
}

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
