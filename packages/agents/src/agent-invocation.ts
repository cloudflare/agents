/**
 * Entering an Agent invocation: the context every handler reads, and the
 * wrappers that restore it for public subclass methods reached from outside
 * a Lifecycle hook (native Durable Object RPC, cross-Agent calls).
 *
 * @internal
 */

import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentContextStore
} from "./internal_context";
import { copyCallableMetadata } from "./callable-decorator";
import { getCurrentAgent } from "./lifecycle/current-agent";
import {
  withInvocationScope,
  type InvocationScopeOptions
} from "./observability/tracing/tracer";

/** What the wrappers need from the Agent they run on. */
type InvocationHost = {
  readonly lifecycle: { isStarted(): boolean; start(): Promise<void> };
};

/**
 * Enters an agent invocation: the context every handler reads, plus the span
 * scope that stops invocation-bounded spans from outliving it. Scopes do not
 * nest, so the outermost live entry point owns the boundary — pass
 * `detached` for work that deliberately runs on past its caller.
 *
 * @internal
 */
export function runInInvocation<T>(
  store: AgentContextStore,
  body: () => T,
  options?: InvocationScopeOptions
): T {
  return agentContext.run(store, () => withInvocationScope(body, options));
}

const AsyncFunction: Function = Object.getPrototypeOf(
  async () => {}
).constructor;

/** Functions produced by {@link withAgentContext}, so they are wrapped once. */
const agentContextWrappers = new WeakSet<Function>();

type Method = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Restore Agent context when a public method is entered outside a Lifecycle
 * hook, notably through native Durable Object RPC or cross-Agent re-entry.
 * Lifecycle already owns context for its capability and semantic user hooks.
 *
 * Native RPC bypasses the lifecycle's runtime handlers, so an `async` method
 * entered from outside this Agent's context first starts the lifecycle when
 * the call is the one that wakes a cold instance. Synchronous methods are
 * never deferred, so they keep their synchronous return type.
 *
 * @internal
 */

export function withAgentContext(
  method: Method
): (this: InvocationHost, ...args: unknown[]) => unknown {
  const enter = function (this: InvocationHost, ...args: unknown[]): unknown {
    const { agent } = getCurrentAgent();

    if (agent === this) {
      // already wrapped, so we can just call the method
      return method.apply(this, args);
    }
    // Crossing to a different Agent must not carry native I/O handles
    // from the previous request/WebSocket/email turn into the new DO.
    return runInInvocation(
      {
        agent: this as unknown as AgentContextStore["agent"],
        connection: undefined,
        request: undefined,
        email: undefined
      },
      () => {
        return method.apply(this, args);
      }
    );
  };

  if (!(method instanceof AsyncFunction)) {
    agentContextWrappers.add(enter);
    return enter;
  }

  const enterStarted = async function (
    this: InvocationHost,
    ...args: unknown[]
  ): Promise<unknown> {
    if (getCurrentAgent().agent !== this && !this.lifecycle.isStarted()) {
      await this.lifecycle.start();
    }
    return enter.apply(this, args);
  };
  agentContextWrappers.add(enterStarted);
  return enterStarted;
}

/**
 * Wrap the public methods a subclass adds over `baseProto` with
 * {@link withAgentContext}, on the subclass prototype, once. A callable's
 * metadata moves to its wrapper.
 *
 * @internal
 */
export function wrapCustomMethods(
  instance: object,
  baseProto: object,
  isCallable: (methodName: string) => boolean
): void {
  // Agent.prototype traversal also covers the DurableObject base class.
  const basePrototypes = [baseProto];
  const baseMethods = new Set<string>();
  for (const baseProto of basePrototypes) {
    let proto = baseProto;
    while (proto && proto !== Object.prototype) {
      const methodNames = Object.getOwnPropertyNames(proto);
      for (const methodName of methodNames) {
        baseMethods.add(methodName);
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
  // The nearest descriptor for a name is authoritative: a subclass getter
  // or field that shadows an inherited method must not be replaced by a
  // wrapper around the inherited method.
  const seen = new Set<string>();
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== baseProto && proto !== Object.prototype) {
    const methodNames = Object.getOwnPropertyNames(proto);
    for (const methodName of methodNames) {
      if (seen.has(methodName)) continue;
      seen.add(methodName);
      const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);

      // Skip if it's a private method, a base method, a getter, or not a function,
      if (
        baseMethods.has(methodName) ||
        methodName.startsWith("_") ||
        !descriptor ||
        !!descriptor.get ||
        typeof descriptor.value !== "function" ||
        agentContextWrappers.has(descriptor.value)
      ) {
        continue;
      }

      const method = descriptor.value as Function;
      const wrappedFunction = withAgentContext(method as Method);

      // if the method is callable, copy the metadata from the original method
      if (isCallable(methodName)) {
        copyCallableMetadata(method, wrappedFunction);
      }

      // set the wrapped function on the prototype
      (instance.constructor.prototype as Record<string, unknown>)[methodName] =
        wrappedFunction;
    }

    proto = Object.getPrototypeOf(proto);
  }
}

/** Classes already warned about the deprecated `onStateUpdate`. */
const onStateUpdateWarnedClasses = new WeakSet<Function>();

/**
 * Which state notification hook an Agent subclass overrides: `"new"` for
 * `onStateChanged`, `"old"` for the deprecated `onStateUpdate` (warned
 * once per class), `"none"` for neither. Throws if one class overrides both.
 *
 * @internal
 */
export function stateHookMode(
  instance: object,
  baseProto: { onStateChanged: unknown; onStateUpdate: unknown }
): "new" | "old" | "none" {
  const proto = Object.getPrototypeOf(instance);
  const hasOwnNew = Object.prototype.hasOwnProperty.call(
    proto,
    "onStateChanged"
  );
  const hasOwnOld = Object.prototype.hasOwnProperty.call(
    proto,
    "onStateUpdate"
  );
  if (hasOwnNew && hasOwnOld) {
    throw new Error(
      `[Agent] Cannot override both onStateChanged and onStateUpdate. ` +
        `Remove onStateUpdate — it has been renamed to onStateChanged.`
    );
  }
  if (hasOwnOld && !onStateUpdateWarnedClasses.has(instance.constructor)) {
    onStateUpdateWarnedClasses.add(instance.constructor);
    console.warn(
      `[Agent] onStateUpdate is deprecated. Rename to onStateChanged — the behavior is identical.`
    );
  }
  if (proto.onStateChanged !== baseProto.onStateChanged) return "new";
  if (proto.onStateUpdate !== baseProto.onStateUpdate) return "old";
  return "none";
}
