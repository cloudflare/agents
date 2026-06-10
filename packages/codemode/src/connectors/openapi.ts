import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { CodemodeConnector, type ConnectorTools } from "./base";
import { sanitizeToolName } from "../utils";

export type OpenApiRequestOptions = {
  /** Path or URL to call, with path params already substituted. */
  path: string;
  method?: string;
  /** Query parameters to append to the URL. */
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
};

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head"
] as const;

type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JSONSchema7Definition;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: JSONSchema7Definition }>;
  };
};

/**
 * Connector backed by an OpenAPI spec.
 *
 * The base reads the spec **once, host-side** and derives one typed tool per
 * operation — so the model calls `api.get_repository({ owner, repo })` directly
 * (discoverable via `codemode.search` / `codemode.describe`, with input types)
 * instead of fetching the raw spec and hand-writing operation lookups on every
 * run. Deriving on the host costs zero prompt tokens.
 *
 * Override two methods:
 *
 *   - `spec()`    returns the OpenAPI document (used to derive operations)
 *   - `request()` performs the authenticated HTTP call
 *
 * A low-level `request` tool is also exposed as an escape hatch for operations
 * the model can't reach through a derived tool.
 *
 * The per-operation tool's input is a single object: top-level keys are the
 * operation's path/query/header parameters, plus a `body` key when the
 * operation has a JSON request body. The derived tool substitutes path params,
 * then hands `request()` a clean `{ path, method, params, body, headers }`.
 *
 * (The sandbox-facing escape hatch is `request`, not `fetch`, because `fetch`
 * is reserved by `WorkerEntrypoint`.)
 */
export abstract class OpenApiConnector<
  Env = unknown,
  Props = unknown
> extends CodemodeConnector<Env, Props> {
  protected abstract spec():
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;

  protected abstract request(options: OpenApiRequestOptions): Promise<unknown>;

  /** Whether to also expose the raw `spec` document as a tool. Off by default. */
  protected exposeSpec(): boolean {
    return false;
  }

  protected override async tools(): Promise<ConnectorTools> {
    const doc = await this.spec();
    const operations = deriveOperations(doc);

    const tools: ConnectorTools = {};

    if (this.exposeSpec()) {
      tools.spec = {
        description: "Return the raw OpenAPI document.",
        inputSchema: { type: "object", properties: {} },
        execute: () => this.spec()
      };
    }

    tools.request = {
      description:
        "Escape hatch: perform an authenticated request to a path (and optional method, params, body, headers). Prefer the per-operation tools.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          method: { type: "string" },
          params: { type: "object", additionalProperties: true },
          body: {},
          headers: { type: "object", additionalProperties: { type: "string" } }
        },
        required: ["path"]
      },
      execute: (args) => this.request(args as OpenApiRequestOptions)
    };

    // The derived operation metadata is cached (host-side, by spec identity);
    // only the `execute` closure — which must bind to *this* instance's
    // `request()` — is created fresh here.
    for (const op of operations) {
      tools[op.name] = {
        description: op.description,
        inputSchema: op.inputSchema,
        execute: (args) => this.request(toRequest(op, args))
      };
    }

    return tools;
  }
}

// ---------------------------------------------------------------------------
// Operation derivation — pure, cached host-side by spec identity.
//
// Parsing a spec and resolving its schemas is the expensive part, and a spec is
// static, but connectors are reconstructed per message — so we memoize the
// derived (closure-free) operation metadata on the spec object itself. The
// per-instance `execute` is attached in `tools()`, never cached.
// ---------------------------------------------------------------------------

type DerivedOperation = {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  path: string;
  method: string;
  parameters: OpenApiParameter[];
};

const RESERVED_TOOL_NAMES = new Set(["request", "spec"]);

const operationCache = new WeakMap<object, DerivedOperation[]>();

function deriveOperations(spec: unknown): DerivedOperation[] {
  if (!spec || typeof spec !== "object") return [];
  const cached = operationCache.get(spec);
  if (cached) return cached;
  const derived = buildOperations(spec as Record<string, unknown>);
  operationCache.set(spec, derived);
  return derived;
}

function buildOperations(doc: Record<string, unknown>): DerivedOperation[] {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const operations: DerivedOperation[] = [];
  const used = new Set<string>();

  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method] as OpenApiOperation | undefined;
      if (!operation || typeof operation !== "object") continue;
      const name = operationName(method, path, operation);
      if (!name) continue;
      if (RESERVED_TOOL_NAMES.has(name) || used.has(name)) {
        console.warn(
          `[OpenApiConnector] operation ${method.toUpperCase()} ${path} maps to ` +
            `tool name "${name}", which is ${
              RESERVED_TOOL_NAMES.has(name) ? "reserved" : "already used"
            } — skipping. Set a unique operationId to expose it.`
        );
        continue;
      }
      used.add(name);
      operations.push(buildOperation(doc, path, method, operation, name));
    }
  }

  return operations;
}

function operationName(
  method: string,
  path: string,
  operation: OpenApiOperation
): string {
  if (operation.operationId) return sanitizeToolName(operation.operationId);
  return sanitizeToolName(`${method}_${path}`);
}

function buildOperation(
  doc: Record<string, unknown>,
  path: string,
  method: string,
  operation: OpenApiOperation,
  name: string
): DerivedOperation {
  const parameters = (operation.parameters ?? []).filter(
    (p): p is OpenApiParameter => !!p && typeof p === "object" && !!p.name
  );
  const bodySchema = resolveRef(
    operation.requestBody?.content?.["application/json"]?.schema,
    doc
  );
  const bodyRequired = operation.requestBody?.required === true;

  const properties: Record<string, JSONSchema7Definition> = {};
  const required: string[] = [];
  for (const param of parameters) {
    properties[param.name] = withDescription(
      resolveRef(param.schema, doc) ?? {},
      param.description
    );
    if (param.required) required.push(param.name);
  }
  if (bodySchema !== undefined) {
    properties.body = bodySchema;
    if (bodyRequired) required.push("body");
  }

  const inputSchema: JSONSchema7 = {
    type: "object",
    properties,
    ...(required.length ? { required } : {})
  };

  return {
    name,
    description:
      operation.summary ||
      operation.description ||
      `${method.toUpperCase()} ${path}`,
    inputSchema,
    path,
    method,
    parameters
  };
}

function toRequest(op: DerivedOperation, args: unknown): OpenApiRequestOptions {
  const input = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  let resolvedPath = op.path;
  const query: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  for (const param of op.parameters) {
    const value = input[param.name];
    if (value === undefined) continue;
    if (param.in === "path") {
      resolvedPath = resolvedPath.replace(
        `{${param.name}}`,
        encodeURIComponent(String(value))
      );
    } else if (param.in === "query") {
      query[param.name] = value;
    } else if (param.in === "header") {
      headers[param.name] = String(value);
    }
  }

  return {
    path: resolvedPath,
    method: op.method.toUpperCase(),
    ...(Object.keys(query).length ? { params: query } : {}),
    ...("body" in input ? { body: input.body } : {}),
    ...(Object.keys(headers).length ? { headers } : {})
  };
}

// ---------------------------------------------------------------------------
// Minimal local $ref inlining for input schemas.
// ---------------------------------------------------------------------------

function withDescription(
  schema: JSONSchema7Definition,
  description?: string
): JSONSchema7Definition {
  if (!description || typeof schema !== "object") return schema;
  return { ...schema, description: schema.description ?? description };
}

/**
 * Inline local `#/...` `$ref`s so the generated input types are usable,
 * recursing through `properties`, `items`, `additionalProperties`, and the
 * `allOf`/`oneOf`/`anyOf` combinators. External refs and cycles degrade to an
 * open object rather than throwing.
 */
function resolveRef(
  schema: JSONSchema7Definition | undefined,
  root: Record<string, unknown>,
  seen: Set<string> = new Set()
): JSONSchema7Definition | undefined {
  if (schema === undefined || typeof schema === "boolean") return schema;

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return { type: "object" };
    const target = pointer(root, ref.slice(2).split("/"));
    if (target === undefined) return { type: "object" };
    return resolveRef(
      target as JSONSchema7Definition,
      root,
      new Set(seen).add(ref)
    );
  }

  const out: JSONSchema7 = { ...schema };
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = resolveRef(value, root, seen) ?? {};
    }
  }
  if (schema.items && !Array.isArray(schema.items)) {
    out.items = resolveRef(schema.items, root, seen);
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    out.additionalProperties = resolveRef(
      schema.additionalProperties,
      root,
      seen
    );
  }
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const branch = schema[key];
    if (Array.isArray(branch)) {
      out[key] = branch.map((s) => resolveRef(s, root, seen) ?? {});
    }
  }
  return out;
}

function pointer(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
