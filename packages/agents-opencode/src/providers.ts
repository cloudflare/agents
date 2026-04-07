import type { Config } from "@opencode-ai/sdk/v2";
import type {
  ProviderID,
  ProviderCredentials,
  AllProviderCredentials,
  ResolvedProvider
} from "./types";

/**
 * Build provider config block for Cloudflare Workers AI.
 * The baseURL is set explicitly with the account ID baked in because
 * the provider's env-var interpolation does not work reliably inside
 * the sandbox container.
 */
function buildCloudflareProviderBlock(
  accountId: string
): NonNullable<Config["provider"]> {
  return {
    "cloudflare-workers-ai": {
      options: {
        baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
      },
      models: {
        "@cf/moonshotai/kimi-k2.5": {}
      }
    }
  };
}

/** Build provider config block for Anthropic. */
function buildAnthropicProviderBlock(): NonNullable<Config["provider"]> {
  return {
    anthropic: {
      options: {},
      models: {
        "claude-sonnet-4-20250514": {}
      }
    }
  };
}

/** Build provider config block for OpenAI. */
function buildOpenAIProviderBlock(): NonNullable<Config["provider"]> {
  return {
    openai: {
      options: {},
      models: {
        "gpt-5.4": {}
      }
    }
  };
}

/** Map from provider ID to the default model string for that provider. */
const DEFAULT_MODELS: Record<ProviderID, string> = {
  "cloudflare-workers-ai": "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.5",
  anthropic: "anthropic/claude-sonnet-4-20250514",
  openai: "openai/gpt-5.4"
};

/**
 * Resolve one or more provider credentials into a merged configuration.
 *
 * When multiple credentials are provided, all provider blocks are merged
 * into a single OpenCode Config so every model is available in the sandbox.
 * The `defaultProvider` determines which model is set in `config.model`.
 *
 * If a `userConfig` is supplied (e.g. from the user's OpenCode config file),
 * it is recursively merged on top and takes precedence over auto-detected
 * values.
 */
export function resolveProviders(
  all: AllProviderCredentials,
  userConfig?: Partial<Config>
): ResolvedProvider {
  const mergedProviderBlocks: NonNullable<Config["provider"]> = {};
  const mergedEnv: Record<string, string> = {};
  const auths: ResolvedProvider["auths"] = [];

  for (const creds of all.credentials) {
    switch (creds.provider) {
      case "cloudflare-workers-ai": {
        Object.assign(
          mergedProviderBlocks,
          buildCloudflareProviderBlock(creds.accountId)
        );
        mergedEnv.CLOUDFLARE_ACCOUNT_ID = creds.accountId;
        mergedEnv.CLOUDFLARE_API_KEY = creds.apiKey;
        auths.push({
          providerID: "cloudflare-workers-ai",
          auth: { type: "api", key: creds.apiKey }
        });
        break;
      }
      case "anthropic": {
        Object.assign(mergedProviderBlocks, buildAnthropicProviderBlock());
        mergedEnv.ANTHROPIC_API_KEY = creds.apiKey;
        auths.push({
          providerID: "anthropic",
          auth: { type: "api", key: creds.apiKey }
        });
        break;
      }
      case "openai": {
        Object.assign(mergedProviderBlocks, buildOpenAIProviderBlock());
        mergedEnv.OPENAI_API_KEY = creds.apiKey;
        auths.push({
          providerID: "openai",
          auth: { type: "api", key: creds.apiKey }
        });
        break;
      }
    }
  }

  const config: Config = {
    model: DEFAULT_MODELS[all.defaultProvider],
    provider: mergedProviderBlocks,
    permission: {
      "*": "allow",
      question: "deny"
    },
    autoupdate: false
  };

  if (userConfig) {
    deepMerge(config, userConfig);
  }

  return {
    id: all.defaultProvider,
    config,
    env: mergedEnv,
    auths
  };
}

/**
 * Detect all available provider credentials from environment variables.
 *
 * Returns every provider whose credentials are present. The default
 * provider is inferred from `userConfigModel` if provided (e.g.
 * `"anthropic/claude-sonnet-4-20250514"` → `"anthropic"`). If no model
 * is specified, the first detected provider wins.
 *
 * Returns null if no provider credentials are found.
 */
export function detectProviders(
  env: Record<string, unknown>,
  userConfigModel?: string
): AllProviderCredentials | null {
  const credentials: ProviderCredentials[] = [];

  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY) {
    credentials.push({ provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY });
  }

  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY) {
    credentials.push({ provider: "openai", apiKey: env.OPENAI_API_KEY });
  }

  if (
    typeof env.CLOUDFLARE_ACCOUNT_ID === "string" &&
    env.CLOUDFLARE_ACCOUNT_ID &&
    typeof env.CLOUDFLARE_API_KEY === "string" &&
    env.CLOUDFLARE_API_KEY
  ) {
    credentials.push({
      provider: "cloudflare-workers-ai",
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: env.CLOUDFLARE_API_KEY
    });
  }

  if (credentials.length === 0) return null;

  const detectedIds = credentials.map((c) => c.provider);
  let defaultProvider: ProviderID = detectedIds[0];

  // Infer default provider from userConfig.model if provided
  if (userConfigModel) {
    const modelProvider = inferProviderFromModel(userConfigModel);
    if (modelProvider && detectedIds.includes(modelProvider)) {
      defaultProvider = modelProvider;
    }
  }

  return { credentials, defaultProvider };
}

/**
 * Infer a ProviderID from a model string like "anthropic/claude-sonnet-4-20250514".
 * Returns the provider ID if the prefix matches a known provider, or null.
 */
export function inferProviderFromModel(model: string): ProviderID | null {
  const prefix = model.split("/")[0];
  const KNOWN_PROVIDERS: Record<string, ProviderID> = {
    anthropic: "anthropic",
    openai: "openai",
    "cloudflare-workers-ai": "cloudflare-workers-ai"
  };
  return KNOWN_PROVIDERS[prefix] ?? null;
}

/**
 * Describe which env vars are needed for each provider.
 * Used in error messages to guide the user.
 */
export function describeRequiredEnvVars(): string {
  return [
    "Set one or more of the following provider credentials:",
    "  • ANTHROPIC_API_KEY — for Anthropic (Claude)",
    "  • OPENAI_API_KEY — for OpenAI (GPT-4)",
    "  • CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_KEY — for Cloudflare Workers AI",
    "All detected providers will be available in the sandbox."
  ].join("\n");
}

/**
 * Get the provider ID for display purposes.
 */
export function getProviderDisplayName(id: ProviderID): string {
  switch (id) {
    case "cloudflare-workers-ai":
      return "Cloudflare Workers AI";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
  }
}

/**
 * Recursively merge `source` into `target`, mutating `target`.
 * Arrays are replaced, not concatenated. Primitives from source
 * overwrite target. `undefined` values in source are skipped.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = target[key];
    if (
      typeof srcVal === "object" &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else {
      target[key] = srcVal;
    }
  }
}
