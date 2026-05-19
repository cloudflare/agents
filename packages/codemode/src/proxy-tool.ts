import { tool, type Tool } from "ai";
import { z } from "zod";
import { generateTypesFromJsonSchema } from "./json-schema-types";
import type { Executor, ResolvedProvider, ToolProvider } from "./executor";
import type { ToolProviderWithDescriptors } from "./providers/types";
import { filterTools, extractFns } from "./resolve";
import { runCode } from "./run-code";
import type { CodeOutput } from "./shared";
import { sanitizeToolName } from "./utils";

export type ProxyToolInput = {
  search?: string;
  describe?: string;
  execute?: string;
};

export type ProxyToolOutput = CodeOutput | string;
export type CodeProvider = Promise<ToolProvider>;

export type CreateProxyToolOptions = {
  providers: CodeProvider[];
  executor: Executor;
  description?: string;
};

const proxySchema = z.object({
  search: z.string().optional(),
  describe: z.string().optional(),
  execute: z.string().optional()
});

function providerStatus(providers: ToolProvider[]): string {
  const rows = providers.map((provider) => {
    const tools = Object.keys(filterTools(provider.tools));
    return `${provider.name ?? "codemode"} (${tools.length} method${tools.length === 1 ? "" : "s"})`;
  });
  return [`Providers: ${providers.length}`, "", ...rows].join("\n").trim();
}

function providerDescriptors(provider: ToolProvider) {
  return (provider as ToolProviderWithDescriptors).descriptors;
}

function providerTypeForMethod(
  provider: ToolProvider,
  methodName: string
): string {
  const descriptors = providerDescriptors(provider);
  if (!descriptors?.[methodName]) return "";
  return generateTypesFromJsonSchema({ [methodName]: descriptors[methodName] })
    .replace(
      "declare const codemode",
      `declare const ${sanitizeToolName(provider.name ?? "codemode")}`
    )
    .trim();
}

function searchProviders(query: string, providers: ToolProvider[]): string {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const lines: string[] = [];
  for (const provider of providers) {
    for (const [name, descriptor] of Object.entries(
      filterTools(provider.tools)
    )) {
      const safeName = sanitizeToolName(name);
      const schemaDescriptor = providerDescriptors(provider)?.[safeName];
      const description =
        schemaDescriptor?.description ??
        (descriptor &&
        typeof descriptor === "object" &&
        "description" in descriptor
          ? String((descriptor as { description?: unknown }).description ?? "")
          : "");
      const fullName = `${provider.name ?? "codemode"}.${safeName}`;
      if (![fullName, safeName, name, description].some((v) => pattern.test(v)))
        continue;
      lines.push(`${fullName}${description ? ` — ${description}` : ""}`);
    }
  }
  return lines.length
    ? lines.join("\n").trim()
    : `No methods matching "${query}".`;
}

function describeProviders(target: string, providers: ToolProvider[]): string {
  const [maybeProvider, maybeMethod] = target.includes(".")
    ? target.split(".", 2)
    : [target, undefined];
  const provider = providers.find(
    (candidate) => candidate.name === maybeProvider
  );
  if (provider && !maybeMethod) {
    return [
      provider.name ?? "codemode",
      provider.types ?? "",
      searchProviders(provider.name ?? "codemode", [provider])
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  const candidates = provider ? [provider] : providers;
  const methodName = maybeMethod ?? target;
  for (const candidate of candidates) {
    for (const [name, descriptor] of Object.entries(
      filterTools(candidate.tools)
    )) {
      const safeName = sanitizeToolName(name);
      if (safeName !== methodName && name !== methodName) continue;
      const description =
        descriptor &&
        typeof descriptor === "object" &&
        "description" in descriptor
          ? String((descriptor as { description?: unknown }).description ?? "")
          : "";
      const methodTypes = providerTypeForMethod(candidate, safeName);
      return [
        `${candidate.name ?? "codemode"}.${safeName}`,
        description,
        methodTypes
      ]
        .filter(Boolean)
        .join("\n\n")
        .trim();
    }
  }
  return `Provider method "${target}" not found.`;
}

function resolveProviders(providers: ToolProvider[]): {
  resolvedProviders: ResolvedProvider[];
} {
  const resolvedProviders: ResolvedProvider[] = [];
  for (const provider of providers) {
    const filtered = filterTools(provider.tools);
    const resolved: ResolvedProvider = {
      name: provider.name ?? "codemode",
      fns: extractFns(filtered)
    };
    resolvedProviders.push(resolved);
  }
  return { resolvedProviders };
}

export function createProxyTool(
  options: CreateProxyToolOptions
): Tool<ProxyToolInput, ProxyToolOutput> {
  const providersPromise = Promise.all(options.providers);
  return tool({
    description:
      options.description ??
      `Use this tool to search, describe, and execute against provider SDKs.\n\nInputs:\n- { search: "query" } discovers provider SDK methods and snippets.\n- { describe: "provider.method" } inspects one method.\n- { execute: "async () => { ... }" } runs JavaScript against the SDK.`,
    inputSchema: proxySchema,
    execute: async ({ search, describe, execute }) => {
      const providers = await providersPromise;
      const { resolvedProviders } = resolveProviders(providers);
      if (execute) {
        return runCode({
          code: execute,
          executor: options.executor,
          providers: resolvedProviders
        });
      }
      if (describe) return describeProviders(describe, providers);
      if (search !== undefined) return searchProviders(search, providers);
      return providerStatus(providers);
    }
  });
}
