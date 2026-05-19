import type { ToolSet } from "ai";
import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { ToolProvider } from "../executor";
import type { ToolDescriptors } from "../tool-types";
import { sanitizeToolName } from "../utils";
import type { ProviderOptions } from "./types";
import {
  addSnippets,
  attachProviderDescriptors,
  providerTypes
} from "./shared";

export async function toolsetProvider(
  options: ProviderOptions & { tools: ToolDescriptors | ToolSet }
): Promise<ToolProvider> {
  const provider: ToolProvider = {
    name: sanitizeToolName(options.name),
    tools: options.tools,
    types: options.instructions
  };
  const descriptors: JsonSchemaToolDescriptors = {};
  await addSnippets(provider, options.snippets, options.executor, descriptors);
  if (Object.keys(descriptors).length > 0) {
    attachProviderDescriptors(provider, descriptors);
    provider.types = providerTypes(
      provider.name ?? "codemode",
      descriptors,
      options.instructions
    );
  }
  return provider;
}
