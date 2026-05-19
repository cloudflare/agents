import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { SimpleToolRecord, ToolProvider } from "../executor";
import { sanitizeToolName } from "../utils";
import type { ProviderOptions } from "./types";
import {
  addSnippets,
  attachProviderDescriptors,
  providerTypes
} from "./shared";

export type OpenApiRequestOptions = {
  operationId: string;
  params?: Record<string, unknown>;
  body?: unknown;
};

export async function openApiProvider(
  options: ProviderOptions & {
    spec: Record<string, unknown>;
    request: (options: OpenApiRequestOptions) => Promise<unknown>;
  }
): Promise<ToolProvider> {
  const providerName = sanitizeToolName(options.name);
  const descriptors: JsonSchemaToolDescriptors = {
    search: {
      description: "Search the OpenAPI spec.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    },
    request: {
      description: "Execute an OpenAPI operation by operationId.",
      inputSchema: {
        type: "object",
        properties: {
          operationId: { type: "string" },
          params: { type: "object", additionalProperties: true },
          body: {}
        },
        required: ["operationId"]
      }
    }
  };
  const tools: SimpleToolRecord = {
    search: {
      description: "Search the OpenAPI spec.",
      execute: async (input: unknown) => {
        const { query } = input as { query: string };
        const q = query.toLowerCase();
        const paths = (options.spec.paths ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        return Object.entries(paths).flatMap(([path, methods]) =>
          Object.entries(methods).flatMap(([method, operation]) => {
            const op = operation as {
              operationId?: string;
              summary?: string;
              description?: string;
            };
            const haystack = [
              path,
              method,
              op.operationId,
              op.summary,
              op.description
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return haystack.includes(q)
              ? [
                  {
                    path,
                    method,
                    operationId: op.operationId,
                    summary: op.summary
                  }
                ]
              : [];
          })
        );
      }
    },
    request: {
      description: "Execute an OpenAPI operation by operationId.",
      execute: options.request as (input: unknown) => Promise<unknown>
    }
  };
  const provider: ToolProvider = {
    name: providerName,
    tools
  };
  await addSnippets(provider, options.snippets, options.executor, descriptors);
  attachProviderDescriptors(provider, descriptors);
  provider.types = providerTypes(
    providerName,
    descriptors,
    options.instructions
  );
  return provider;
}
