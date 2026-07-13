import { toErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";

export interface CallableMetadata {
  description?: string;
  streaming?: boolean;
}

export interface StreamingResponse {
  send(chunk: unknown): void;
  end(final?: unknown): void;
}

export interface RpcRequest {
  id: string;
  method: string;
  args: unknown[];
}

export type RpcResponse =
  | { type: "rpc"; id: string; success: true; result: unknown; done: boolean }
  | { type: "rpc"; id: string; success: false; error: string; done: true };

export interface CallableRegistry {
  register(
    name: string,
    fn: (...args: unknown[]) => unknown,
    opts?: CallableMetadata & { streaming?: boolean }
  ): void;
  callableMethods(): Map<string, CallableMetadata>;
  dispatch(request: RpcRequest, respond: (r: RpcResponse) => void): Promise<void>;
}

interface RegisteredMethod {
  fn: (...args: unknown[]) => unknown;
  opts: CallableMetadata;
}

export function createCallableRegistry(deps: { bus: EventBus }): CallableRegistry {
  const methods = new Map<string, RegisteredMethod>();

  async function dispatchStreaming(entry: RegisteredMethod, request: RpcRequest, respond: (r: RpcResponse) => void): Promise<void> {
    let ended = false;
    const stream: StreamingResponse = {
      send(chunk) {
        if (ended) return;
        respond({ type: "rpc", id: request.id, success: true, result: chunk, done: false });
      },
      end(final) {
        if (ended) return;
        ended = true;
        respond({ type: "rpc", id: request.id, success: true, result: final, done: true });
      },
    };

    try {
      const returned = await entry.fn(stream, ...request.args);
      if (!ended) {
        ended = true;
        respond({ type: "rpc", id: request.id, success: true, result: returned, done: true });
      }
      deps.bus.emit("rpc", { method: request.method, streaming: true });
    } catch (err) {
      const { message } = toErrorValue(err);
      if (!ended) {
        ended = true;
        respond({ type: "rpc", id: request.id, success: false, error: message, done: true });
      }
      deps.bus.emit("rpc:error", { method: request.method, error: message });
    }
  }

  async function dispatchPlain(entry: RegisteredMethod, request: RpcRequest, respond: (r: RpcResponse) => void): Promise<void> {
    try {
      const result = await entry.fn(...request.args);
      respond({ type: "rpc", id: request.id, success: true, result, done: true });
      deps.bus.emit("rpc", { method: request.method });
    } catch (err) {
      const { message } = toErrorValue(err);
      respond({ type: "rpc", id: request.id, success: false, error: message, done: true });
      deps.bus.emit("rpc:error", { method: request.method, error: message });
    }
  }

  return {
    register(name, fn, opts) {
      methods.set(name, {
        fn,
        opts: { description: opts?.description, streaming: opts?.streaming },
      });
    },

    callableMethods() {
      const result = new Map<string, CallableMetadata>();
      for (const [name, entry] of methods) {
        result.set(name, entry.opts);
      }
      return result;
    },

    async dispatch(request, respond) {
      const entry = methods.get(request.method);
      if (!entry) {
        respond({
          type: "rpc",
          id: request.id,
          success: false,
          error: `not callable: ${request.method}`,
          done: true,
        });
        return;
      }
      if (entry.opts.streaming) {
        await dispatchStreaming(entry, request, respond);
      } else {
        await dispatchPlain(entry, request, respond);
      }
    },
  };
}

// --- Decorator -------------------------------------------------------------
//
// TC39 stage-3 method decorators run once, at class-definition time, and do
// not receive the instance. To let an app-layer constructor discover which
// methods were tagged `@callable`, the decorator uses `ctx.addInitializer`,
// which registers a callback that runs with `this` bound to each new
// instance as it is constructed. That callback records the tag in a
// per-instance map keyed off a module-private symbol, which `scanCallables`
// reads back out.

const CALLABLE_TAGS = Symbol("callableTags");

interface TaggedInstance {
  [CALLABLE_TAGS]?: Map<string, CallableMetadata>;
}

/** Stage-3 TC39 method decorator: `@callable({ description?, streaming? })`. */
export function callable(opts: CallableMetadata = {}) {
  return function callableDecorator(method: unknown, ctx: ClassMethodDecoratorContext): void {
    if (ctx.kind !== "method") {
      throw new TypeError("@callable can only decorate instance methods");
    }
    const name = String(ctx.name);
    const metadata: CallableMetadata = { description: opts.description, streaming: opts.streaming };
    ctx.addInitializer(function (this: unknown) {
      const self = this as TaggedInstance;
      const tags = self[CALLABLE_TAGS] ?? new Map<string, CallableMetadata>();
      tags.set(name, metadata);
      self[CALLABLE_TAGS] = tags;
    });
  };
}

/**
 * Reads back the methods tagged `@callable` on a constructed instance,
 * bound and ready to hand to `CallableRegistry.register`.
 */
export function scanCallables(
  instance: object
): Map<string, { fn: (...args: unknown[]) => unknown; opts: CallableMetadata }> {
  const tags = (instance as TaggedInstance)[CALLABLE_TAGS];
  const result = new Map<string, { fn: (...args: unknown[]) => unknown; opts: CallableMetadata }>();
  if (!tags) return result;
  for (const [name, opts] of tags) {
    const fn = (instance as Record<string, unknown>)[name];
    if (typeof fn !== "function") continue;
    result.set(name, { fn: fn.bind(instance), opts });
  }
  return result;
}
