import type { ToolSet } from "ai";
import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { ToolDescriptors } from "../tool-types";
import { sanitizeToolName } from "../utils";
import type { NamedToolProvider, ProviderOptions } from "./types";
import {
  addSnippets,
  attachProviderDescriptors,
  providerTypes
} from "./shared";

export async function toolsetProvider(
  options: ProviderOptions & { tools: ToolDescriptors | ToolSet }
): Promise<NamedToolProvider> {
  const provider: NamedToolProvider = {
    name: sanitizeToolName(options.name),
    tools: options.tools,
    types: options.instructions
  };
  const descriptors: JsonSchemaToolDescriptors = {};
  await addSnippets(provider, options.snippets, options.executor, descriptors);
  if (Object.keys(descriptors).length > 0) {
    attachProviderDescriptors(provider, descriptors);
    provider.types = providerTypes(
      provider.name,
      descriptors,
      options.instructions
    );
  }
  return provider;
}
