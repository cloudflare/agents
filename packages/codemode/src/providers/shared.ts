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
  ProviderSnippetRecord,
  ToolProviderWithDescriptors
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

export function providerTypes(
  providerName: string,
  descriptors: JsonSchemaToolDescriptors,
  instructions?: string
): string {
  return [instructions, declarationsForProvider(providerName, descriptors)]
    .filter(Boolean)
    .join("\n\n");
}

export function methodTypes(
  descriptors: JsonSchemaToolDescriptors,
  methodName: string
): string {
  const descriptor = descriptors[methodName];
  if (!descriptor) return "";
  const generatedTypes = generateTypesFromJsonSchema({
    [methodName]: descriptor
  });
  return generatedTypes
    .slice(0, generatedTypes.indexOf("declare const codemode"))
    .trim();
}

export function describeProvider(provider: NamedToolProvider): string {
  const descriptors = (provider as ToolProviderWithDescriptors).descriptors;
  return [
    provider.name,
    descriptors ? providerTypes(provider.name, descriptors) : provider.types
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function describeProviderMethod(
  provider: NamedToolProvider,
  methodName: string
): string {
  const descriptors = (provider as ToolProviderWithDescriptors).descriptors;
  return descriptors ? methodTypes(descriptors, methodName) : "";
}

export function attachProviderDescriptors(
  provider: NamedToolProvider,
  descriptors: JsonSchemaToolDescriptors
): void {
  (provider as ToolProviderWithDescriptors).descriptors = descriptors;
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
