import { RpcTarget } from "cloudflare:workers";
import { decoratedMethods } from "../callable-decorator";
import {
  CAPNWEB_STREAMING_RESULT,
  CAPNWEB_TRANSPORT_SEND,
  type CapnWebStreamingEvent,
  type CapnWebStreamingResult
} from "./transport-protocol";

/** A callable method ready to be exposed on a connection. */
export type CallableMethod = {
  readonly invoke: (...args: unknown[]) => unknown;
  readonly streaming: boolean;
};

const methodMetadata = new WeakMap<Function, Pick<CallableMethod, "streaming">>();
const handlerDispatchedTargets = new WeakSet<RpcTarget>();

/**
 * The single exposure policy for callable names. `Object.prototype` and
 * `RpcTarget.prototype` members are unreachable over Cap'n Web and are
 * silently excluded. Reserved framework names and `then` are rejected.
 */
function assertExposable(name: string): boolean {
  if (name === "then") {
    throw new Error(
      'A callables target cannot expose a method named "then" because it would make the remote stub thenable'
    );
  }
  if (name === CAPNWEB_TRANSPORT_SEND) {
    throw new Error(
      `A callables target cannot expose the reserved framework method "${CAPNWEB_TRANSPORT_SEND}"`
    );
  }
  return !(
    name === "constructor" ||
    name in Object.prototype ||
    name in RpcTarget.prototype
  );
}

/**
 * The exposable prototype methods of a callables target, each bound to
 * invoke on the real instance so private fields and `this` behave.
 *
 * Cap'n Web resolves methods on the prototype chain and rejects own
 * instance properties, so only prototype methods participate. The
 * nearest declaration wins for overridden names.
 *
 * @param target - The callables target to enumerate.
 * @returns Method names mapped to bound invokers and streaming metadata.
 */
export function exposableMethods(
  target: RpcTarget
): ReadonlyMap<string, CallableMethod> {
  const methods = new Map<string, CallableMethod>();
  const seen = new Set<string>();
  let prototype: object | null = Object.getPrototypeOf(target);
  while (
    prototype &&
    prototype !== RpcTarget.prototype &&
    prototype !== Object.prototype
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!assertExposable(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      // SAFETY: `typeof descriptor.value === "function"` was checked above.
      const method = descriptor.value as (...args: unknown[]) => unknown;
      methods.set(name, {
        invoke: (...args) => Reflect.apply(method, target, args),
        streaming: methodMetadata.get(method)?.streaming ?? false
      });
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return methods;
}

/**
 * Build a Cap'n Web session root exposing exactly the given methods.
 *
 * Cap'n Web resolves methods on the prototype chain, rejects own instance
 * properties, and breaks on Proxy-wrapped roots. The generated root is an
 * `RpcTarget` subclass whose prototype carries only the supplied methods.
 *
 * @param methods - Method names mapped to their invocation behavior.
 * @param dispose - Optional cleanup called when the remote root is released.
 * @returns A root suitable as a Cap'n Web session's local main.
 */
export function buildCallablesRoot(
  methods: ReadonlyMap<string, CallableMethod>,
  dispose?: () => void
): RpcTarget {
  class CallablesRoot extends RpcTarget {}
  for (const [name, method] of methods) {
    methodMetadata.set(method.invoke, { streaming: method.streaming });
    Object.defineProperty(CallablesRoot.prototype, name, {
      value: method.invoke,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (dispose) {
    Object.defineProperty(CallablesRoot.prototype, Symbol.dispose, {
      value: dispose,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return new CallablesRoot();
}

/**
 * Whether hibernating JSON RPC frames must remain with the host handler.
 * Agent uses this for facet routing and its legacy streaming protocol.
 * Native Cap'n Web calls can still use the target directly.
 *
 * @param target - The configured callables target.
 * @returns True when the host handler owns hibernating RPC dispatch.
 */
export function callablesUseHostMessageHandler(target: RpcTarget): boolean {
  return handlerDispatchedTargets.has(target);
}

/**
 * Build a callables target from a host's `@callable()`-decorated methods.
 *
 * Methods are resolved on the host at call time, so framework wrapping
 * applied after construction is honored. Legacy streaming methods are
 * projected as an internal streamed result which `useAgent` turns back into
 * its existing callback and final-result behavior.
 *
 * The returned target leaves hibernating JSON RPC frames with Agent's
 * message handler because that handler also owns facet forwarding.
 *
 * @param host - The object whose decorated methods form the interface.
 * @returns A target exposing the decorated methods, or `undefined` when the
 * host has none.
 */
export function callablesFromDecorated(host: object): RpcTarget | undefined {
  const methods = new Map<string, CallableMethod>();
  for (const [name, metadata] of decoratedMethods(host)) {
    if (!assertExposable(name)) continue;
    methods.set(name, {
      streaming: metadata.streaming === true,
      invoke: (...args) => {
        const method = Reflect.get(host, name) as unknown;
        if (typeof method !== "function") {
          throw new Error(`Method ${name} is not callable`);
        }
        // SAFETY: the runtime check above narrowed this dynamic property to a
        // callable; TypeScript narrows it only to the wider `Function` type.
        const callable = method as (...args: unknown[]) => unknown;
        if (!metadata.streaming) return Reflect.apply(callable, host, args);
        return invokeStreamingMethod(callable, host, args);
      }
    });
  }
  if (methods.size === 0) return undefined;
  const target = buildCallablesRoot(methods);
  handlerDispatchedTargets.add(target);
  return target;
}

function invokeStreamingMethod(
  method: (...args: unknown[]) => unknown,
  host: object,
  args: unknown[]
): CapnWebStreamingResult {
  let closed = false;
  let controller: ReadableStreamDefaultController<CapnWebStreamingEvent>;
  const stream = new ReadableStream<CapnWebStreamingEvent>({
    start(nextController) {
      controller = nextController;
      const response = {
        get isClosed() {
          return closed;
        },
        send(chunk: unknown): boolean {
          if (closed) return false;
          controller.enqueue({ type: "chunk", value: chunk });
          return true;
        },
        end(finalValue?: unknown): boolean {
          if (closed) return false;
          closed = true;
          controller.enqueue({ type: "done", value: finalValue });
          controller.close();
          return true;
        },
        error(message: string): boolean {
          if (closed) return false;
          closed = true;
          controller.error(new Error(message));
          return true;
        }
      };

      try {
        void Promise.resolve(
          Reflect.apply(method, host, [response, ...args])
        ).catch((error: unknown) => {
          if (closed) return;
          closed = true;
          controller.error(error);
        });
      } catch (error) {
        closed = true;
        controller.error(error);
      }
    },
    cancel() {
      closed = true;
    }
  });

  return {
    [CAPNWEB_STREAMING_RESULT]: true,
    stream
  };
}
