import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import { CodemodeConnector } from "./base";

export type OpenApiRequestOptions = {
  /** Path or URL to call, e.g. an OpenAPI path from `spec()`. */
  path: string;
  method?: string;
  /** Path/query params to substitute or append. */
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Connector backed by an OpenAPI spec.
 *
 * The model is good at writing code, so the surface is data plus an
 * authenticated capability. Override two methods:
 *
 *   - `spec()`    returns the OpenAPI document into the sandbox (no prompt tokens)
 *   - `request()` performs an authenticated request
 *
 * The model reads the spec, finds the operation it wants in code, and calls
 * `request()`. No pre-baked per-operation methods.
 *
 * (The sandbox-facing method is exposed as `request`, not `fetch`, because
 * `fetch` is reserved by `WorkerEntrypoint` for the Worker HTTP handler.)
 *
 * ```ts
 * const spec = await stripe.spec();
 * const op = Object.entries(spec.paths)
 *   .flatMap(([path, methods]) =>
 *     Object.entries(methods).map(([method, o]) => ({ path, method, ...o }))
 *   )
 *   .find((o) => o.operationId === "CreatePaymentIntent");
 *
 * const result = await stripe.request({
 *   path: op.path,
 *   method: op.method,
 *   body: { amount: 2000, currency: "usd" }
 * });
 * ```
 */
export abstract class OpenApiConnector<
  Env = unknown,
  Props = unknown
> extends CodemodeConnector<Env, Props> {
  protected abstract spec():
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;

  protected abstract request(options: OpenApiRequestOptions): Promise<unknown>;

  protected override async loadDescriptors(): Promise<JsonSchemaToolDescriptors> {
    return {
      spec: {
        description:
          "Return the OpenAPI spec document so you can find operations in code.",
        inputSchema: { type: "object", properties: {} }
      },
      request: {
        description:
          "Perform an authenticated request. Pass a path (and optional method, params, body, headers).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            method: { type: "string" },
            params: { type: "object", additionalProperties: true },
            body: {},
            headers: {
              type: "object",
              additionalProperties: { type: "string" }
            }
          },
          required: ["path"]
        }
      }
    };
  }

  async executeTool(method: string, args: unknown): Promise<unknown> {
    if (method === "spec") {
      return this.spec();
    }
    if (method === "request") {
      return this.request(args as OpenApiRequestOptions);
    }
    throw new Error(`Unknown method "${method}" on ${this.name()}`);
  }
}
