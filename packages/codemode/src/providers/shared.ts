import type { JSONSchema7 } from "json-schema";
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "../json-schema-types";
import { runCode } from "../run-code";
import { sanitizeToolName } from "../utils";
import type { Executor, ResolvedProvider, SimpleToolRecord } from "../executor";
import type {
  NamedToolProvider,
  ProviderDocs,
  ProviderSnippetRecord
} from "./types";

function declarationsForProvider(
  providerName: string,
  descriptors: JsonSchemaToolDescriptors
): string {
  return generateTypesFromJsonSchema(descriptors).replace(
    "declare const codemode",
    `declare const ${sanitizeToolName(providerName)}`
  );
}

function renderProviderTypes(providerName: string, docs: ProviderDocs): string {
  return [
    docs.instructions,
    declarationsForProvider(providerName, docs.descriptors)
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderProviderDescription(provider: NamedToolProvider): string {
  return [
    provider.name,
    provider.docs
      ? renderProviderTypes(provider.name, provider.docs)
      : provider.types
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function renderMethodDescription(
  provider: NamedToolProvider,
  methodName: string
): string {
  const descriptor = provider.docs?.descriptors[methodName];
  if (!descriptor) return "";
  const generatedTypes = generateTypesFromJsonSchema({
    [methodName]: descriptor
  });
  return generatedTypes
    .slice(0, generatedTypes.indexOf("declare const codemode"))
    .trim();
}

export function getMethodDescription(
  provider: NamedToolProvider,
  methodName: string
): string | undefined {
  return provider.docs?.descriptors[methodName]?.description;
}

function resolvedProviderFromToolProvider(
  provider: NamedToolProvider
): ResolvedProvider {
  return {
    name: provider.name,
    fns: Object.fromEntries(
      Object.entries(provider.tools).flatMap(([name, tool]) => {
        const execute =
          tool && typeof tool === "object" && "execute" in tool
            ? (tool as { execute?: (input: unknown) => Promise<unknown> })
                .execute
            : undefined;
        return execute ? [[name, execute]] : [];
      })
    )
  };
}

export async function addSnippets(
  provider: NamedToolProvider,
  snippets: ProviderSnippetRecord | undefined,
  executor: Executor | undefined,
  descriptors: JsonSchemaToolDescriptors
): Promise<void> {
  if (!snippets) return;
  for (const [name, snippet] of Object.entries(snippets)) {
    const sdkName = sanitizeToolName(name);
    descriptors[sdkName] = {
      description: snippet.description,
      inputSchema: snippet.inputSchema as JSONSchema7,
      outputSchema: snippet.outputSchema as JSONSchema7 | undefined
    };
    (provider.tools as SimpleToolRecord)[sdkName] = {
      description: snippet.description,
      execute: async (args: unknown) => {
        if (!executor)
          throw new Error(`Snippet "${name}" requires an executor.`);
        const result = await runCode({
          executor,
          code: `async () => {\n  const snippet = (${snippet.code});\n  return await snippet(${JSON.stringify(args)});\n}`,
          providers: [resolvedProviderFromToolProvider(provider)]
        });
        return result.result;
      }
    };
  }
}
