import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { Executor, ToolProvider } from "../executor";

export type ProviderSnippet = {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  code: string;
};

export type ProviderSnippetRecord = Record<string, ProviderSnippet>;

export type ProviderOptions = {
  name: string;
  instructions?: string;
  snippets?: ProviderSnippetRecord;
  executor?: Executor;
};

export type NamedToolProvider = ToolProvider & {
  name: string;
};

export type ToolProviderWithDescriptors = NamedToolProvider & {
  descriptors?: JsonSchemaToolDescriptors;
};
