import { AgentError, NotFoundError } from "../../kernel/errors.js";
import type { AgentHandle, AgentSpawner } from "../../ports/agent-spawner.js";

type RpcCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string; code?: unknown } };

/**
 * Facet-backed AgentSpawner for Cloudflare Durable Objects.
 *
 * Child alarms are virtualized by the hosting shell: a child writes its
 * requested wake time to its own storage, then this spawner re-syncs that
 * request to the root after each child RPC. The root stores
 * cf-shell:child-alarm:<facetKey> rows and owns the single physical Durable
 * Object alarm slot. This deliberately avoids storing Workers RPC callback
 * stubs across RPC turns; in this runtime those stubs are disposed when the
 * call that carried them ends.
 */
export function createFacetSpawner(deps: {
  ctx: DurableObjectState;
  selfPath: Array<{ className: string; name: string }>;
  arm: (facetKey: string, at: number | null) => void;
}): AgentSpawner {
  const handles = new Map<string, AgentHandle>();
  const initPromises = new Map<string, Promise<void>>();

  function facetKey(className: string, name: string): string {
    return `${className}\0${name}`;
  }

  function stubFor(className: string, name: string): DurableObjectStub {
    const Ctor = deps.ctx.exports[className];
    if (Ctor === undefined) {
      throw new NotFoundError(`Unknown agent class: ${className}`);
    }
    return deps.ctx.facets.get(facetKey(className, name), () => ({
      class: Ctor
    })) as DurableObjectStub;
  }

  return {
    get(className: string, name: string): AgentHandle {
      const key = facetKey(className, name);
      const existing = handles.get(key);
      if (existing) return existing;

      const handle: AgentHandle = {
        className,
        name,
        async call<T>(method: string, args: unknown[]): Promise<T> {
          await ensureLinked();
          try {
            const result = await rpcStub().__callResult(method, args);
            if (!result.ok) throw fromRpcError(result.error);
            return result.result as T;
          } finally {
            await syncAlarmRequest();
          }
        },
        abort(reason?: unknown): void {
          deps.ctx.facets.abort(key, reason);
          initPromises.delete(key);
        },
        async destroy(): Promise<void> {
          await ensureLinked();
          await rpcStub().__destroy();
          await deps.ctx.facets.delete(key);
          deps.arm(key, null);
          initPromises.delete(key);
          handles.delete(key);
        }
      };

      function rpcStub(): DurableObjectStub & {
        __init(init: {
          name: string;
          parentPath?: Array<{ className: string; name: string }>;
          facetHosted?: boolean;
        }): Promise<void>;
        __link(link: {
          armChild: (at: number | null) => void;
        }): Promise<number | null>;
        __call<T = unknown>(method: string, args: unknown[]): Promise<T>;
        __callResult(method: string, args: unknown[]): Promise<RpcCallResult>;
        __destroy(): Promise<void>;
      } {
        return stubFor(className, name) as DurableObjectStub & {
          __init(init: {
            name: string;
            parentPath?: Array<{ className: string; name: string }>;
            facetHosted?: boolean;
          }): Promise<void>;
          __link(link: {
            armChild: (at: number | null) => void;
          }): Promise<number | null>;
          __call<T = unknown>(method: string, args: unknown[]): Promise<T>;
          __callResult(method: string, args: unknown[]): Promise<RpcCallResult>;
          __destroy(): Promise<void>;
        };
      }

      function ensureLinked(): Promise<void> {
        let init = initPromises.get(key);
        if (!init) {
          init = (async () => {
            const stub = rpcStub();
            await stub.__init({
              name,
              parentPath: deps.selfPath,
              facetHosted: true
            });
            await syncAlarmRequest();
          })();
          initPromises.set(key, init);
        }
        return init;
      }

      async function syncAlarmRequest(): Promise<void> {
        const at = await rpcStub().__link({
          armChild: (_at: number | null) => {}
        });
        deps.arm(key, at);
      }

      handles.set(key, handle);
      return handle;
    }
  };
}

function fromRpcError(error: {
  name: string;
  message: string;
  code?: unknown;
}): Error {
  if (error.code === "not_found") return new NotFoundError(error.message);
  if (typeof error.code === "string") {
    return new AgentError(error.message, error.code);
  }
  const err = new Error(error.message);
  err.name = error.name;
  return err;
}
