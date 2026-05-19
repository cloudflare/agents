import type { JSONSchema7 } from "json-schema";
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "../json-schema-types";
import { runCode } from "../run-code";
import { sanitizeToolName } from "../utils";
import type {
  Executor,
  ResolvedProvider,
  SimpleToolRecord,
  ToolProvider
} from "../executor";
import type { ProviderSnippetRecord } from "./types";

export function providerTypes(
  providerName: string,
  descriptors: JsonSchemaToolDescriptors,
  instructions?: string
): string {
  const types = generateTypesFromJsonSchema(descriptors).replace(
    "declare const codemode",
    `declare const ${sanitizeToolName(providerName)}`
  );
  return [instructions, types].filter(Boolean).join("\n\n");
}

function resolvedProviderFromToolProvider(
  provider: ToolProvider
): ResolvedProvider {
  return {
    name: provider.name ?? "codemode",
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
  provider: ToolProvider,
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
