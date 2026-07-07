import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthInfo } from "@modelcontextprotocol/server";

const VERIFIED_OAUTH_CONTEXT = Symbol.for(
  "cloudflare.workers-oauth-provider.verified-context.v1"
);

interface VerifiedWorkersOAuthContext {
  version: 1;
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: string;
  props: Record<string, unknown>;
}

export interface McpAuthContext {
  props: Record<string, unknown>;
}

const authContextStorage = new AsyncLocalStorage<McpAuthContext>();

export function getMcpAuthContext(): McpAuthContext | undefined {
  return authContextStorage.getStore();
}

export function runWithAuthContext<T>(context: McpAuthContext, fn: () => T): T {
  return authContextStorage.run(context, fn);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidVerifiedContext(): never {
  throw new TypeError("Invalid verified OAuth request context");
}

export function getVerifiedOAuthAuthInfo(
  ctx: ExecutionContext
): { authInfo: AuthInfo; props: Record<string, unknown> } | undefined {
  const symbolContext = ctx as ExecutionContext & Record<symbol, unknown>;
  if (!(VERIFIED_OAUTH_CONTEXT in symbolContext)) return undefined;

  const value = symbolContext[VERIFIED_OAUTH_CONTEXT];
  if (!isPlainRecord(value) || value.version !== 1) invalidVerifiedContext();

  const candidate = value as Partial<VerifiedWorkersOAuthContext>;
  const { token, clientId, scopes, expiresAt, resource, props } = candidate;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === "string") ||
    !isPlainRecord(props)
  ) {
    invalidVerifiedContext();
  }

  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0)
  ) {
    invalidVerifiedContext();
  }

  let resourceUrl: URL | undefined;
  if (resource !== undefined) {
    if (typeof resource !== "string") invalidVerifiedContext();
    try {
      resourceUrl = new URL(resource);
    } catch {
      invalidVerifiedContext();
    }
    if (resourceUrl.protocol !== "http:" && resourceUrl.protocol !== "https:") {
      invalidVerifiedContext();
    }
  }

  if (ctx.props !== props) invalidVerifiedContext();

  return {
    props,
    authInfo: {
      token,
      clientId,
      scopes: [...scopes],
      ...(expiresAt !== undefined && { expiresAt }),
      ...(resourceUrl !== undefined && { resource: resourceUrl }),
      extra: { props }
    }
  };
}
