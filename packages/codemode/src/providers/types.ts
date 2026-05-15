import type { Executor } from "../executor";

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
