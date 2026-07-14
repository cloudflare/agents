export const DEFAULT_PROVIDER_KEYTERMS = [
  "Cloudflare",
  "Workers AI",
  "Durable Objects",
  "VoiceAgent",
  "Kimi",
  "GLM",
  "GPT OSS"
];

export function getProviderKeyterms(url: URL): string[] {
  const configured = url.searchParams
    .get("keyterms")
    ?.split(",")
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  return configured && configured.length > 0
    ? configured
    : DEFAULT_PROVIDER_KEYTERMS;
}

export function getEnvString(env: Env, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
