import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import { CodemodeConnector } from "./base";

export type OpenApiRequestOptions = {
  operationId: string;
  params?: Record<string, unknown>;
  body?: unknown;
};

/**
 * Connector backed by an OpenAPI spec.
 *
 * Subclass and override `name()`, `spec()`, and `request()`.
 * Exposes two sandbox methods: `search` and `request`.
 */
export abstract class OpenApiConnector<
  Env = unknown,
  Props = unknown
> extends CodemodeConnector<Env, Props> {
  protected abstract spec():
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;

  protected abstract request(input: OpenApiRequestOptions): Promise<unknown>;

  protected override async loadDescriptors(): Promise<JsonSchemaToolDescriptors> {
    return {
      search: {
        description: "Search the OpenAPI spec for operations.",
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
  }

  async executeTool(method: string, args: unknown): Promise<unknown> {
    if (method === "search") {
      const { query } = args as { query: string };
      return searchOpenApiSpec(await this.spec(), query);
    }
    if (method === "request") {
      return this.request(args as OpenApiRequestOptions);
    }
    throw new Error(`Unknown method "${method}" on ${this.name()}`);
  }
}

function searchOpenApiSpec(
  spec: Record<string, unknown>,
  query: string
): unknown[] {
  const q = query.toLowerCase();
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
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
