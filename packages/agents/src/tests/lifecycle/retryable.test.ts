import { env } from "cloudflare:workers";
import { retryable } from "cloudflare:durable-objects";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { isCallableMethod } from "../../callable-decorator";
import { Lifecycle } from "../../lifecycle";
import { isRetryableFor } from "../../lifecycle/retryable";
import { originalRetryableRpc } from "../agents/native-rpc";
import {
  LateRetryableChildAgent,
  RetryableBaseAgent,
  RetryableChildAgent,
  originalWork
} from "../agents/retryable";

vi.mock("cloudflare:durable-objects", () => ({ retryable: vi.fn() }));

const marked = (method: Function) =>
  vi
    .mocked(retryable)
    .mock.calls.some((args: Function[]) => args.includes(method));

describe("Lifecycle.retryable", () => {
  it("marks an Agent method and the context wrapper that native RPC calls", async () => {
    const namespace = env.TestNativeRpcAgent;
    const stub = namespace.get(
      namespace.idFromName(`retryable-${crypto.randomUUID()}`)
    );

    expect(await stub.retryableRpc()).toBe("retryable");

    const result = await runInDurableObject(stub, (instance) => {
      const prototype = Object.getPrototypeOf(instance);
      return {
        wrapped: prototype.retryableRpc !== originalRetryableRpc,
        originalMarked: marked(originalRetryableRpc),
        wrapperMarked: marked(prototype.retryableRpc),
        otherMethodMarked: marked(prototype.applicationRpc)
      };
    });

    expect(result).toEqual({
      wrapped: true,
      originalMarked: true,
      wrapperMarked: true,
      otherMethodMarked: false
    });
  });

  it("keeps a subclass's opt-in for an inherited method from its siblings", () => {
    class Base {
      inherited() {}
    }
    class Marked extends Base {
      own() {}
    }
    class Child extends Marked {}
    class Sibling extends Base {}

    Lifecycle.retryable(Marked, Base.prototype.inherited, Marked.prototype.own);

    expect(isRetryableFor(Marked, Base.prototype.inherited)).toBe(true);
    expect(isRetryableFor(Child, Base.prototype.inherited)).toBe(true);
    expect(isRetryableFor(Sibling, Base.prototype.inherited)).toBe(false);
    expect(marked(Marked.prototype.own)).toBe(true);
    expect(marked(Marked.prototype.inherited)).toBe(true);
    expect(marked(Child.prototype.inherited)).toBe(true);
    expect(marked(Sibling.prototype.inherited)).toBe(false);
    expect(marked(Base.prototype.inherited)).toBe(false);
  });

  it("forwards every name of an inherited method", () => {
    class Root {
      work() {}
    }
    class Base extends Root {}
    // Found first, one level below `work`.
    Object.defineProperty(Base.prototype, "alias", {
      value: Root.prototype.work,
      writable: true,
      configurable: true
    });
    class Marked extends Base {}

    Lifecycle.retryable(Marked, Marked.prototype.work);

    for (const name of ["alias", "work"]) {
      expect(Object.hasOwn(Marked.prototype, name)).toBe(true);
      expect(marked(Reflect.get(Marked.prototype, name))).toBe(true);
    }
    expect(marked(Root.prototype.work)).toBe(false);
  });

  it("rejects functions that are not methods of the host without registering any", () => {
    class Host {
      own() {}
    }
    class Other {
      work() {}
    }

    expect(() =>
      Lifecycle.retryable(Host, Host.prototype.own, Other.prototype.work)
    ).toThrow(TypeError);
    expect(marked(Host.prototype.own)).toBe(false);
    expect(isRetryableFor(Host, Host.prototype.own)).toBe(false);
  });

  it("marks inherited native RPC methods on plain Durable Objects without marking siblings", async () => {
    for (const [namespace, expected] of [
      [env.RetryablePlainObject, true],
      [env.NonRetryablePlainObject, false]
    ] as const) {
      const name = crypto.randomUUID();
      const stub = namespace.getByName(name);
      expect(await stub.work("result")).toBe(`${name}:result`);
      expect(
        await runInDurableObject(stub, (instance) => marked(instance.work))
      ).toBe(expected);
    }
  });

  it("gives a subclass its own wrapper when its parent was constructed first", async () => {
    const callWork = (namespace: DurableObjectNamespace<RetryableBaseAgent>) =>
      namespace.get(namespace.idFromName(crypto.randomUUID())).work();

    expect(await callWork(env.RetryableBaseAgent)).toBe("work");
    expect(isCallableMethod(RetryableChildAgent.prototype.work)).toBe(true);
    const parentWrapper = RetryableBaseAgent.prototype.work;
    // Registered after the parent's wrapper replaced `work`.
    Lifecycle.retryable(
      LateRetryableChildAgent,
      LateRetryableChildAgent.prototype.work
    );
    // The first RPC to each child must start the lifecycle and enter Agent
    // context, through the forwarding method its opt-in installed.
    expect(await callWork(env.RetryableChildAgent)).toBe("work");
    expect(await callWork(env.LateRetryableChildAgent)).toBe("work");

    for (const child of [RetryableChildAgent, LateRetryableChildAgent]) {
      expect(Object.hasOwn(child.prototype, "work")).toBe(true);
      expect(marked(child.prototype.work)).toBe(true);
      expect(isCallableMethod(child.prototype.work)).toBe(true);
    }
    // Classes that never opted in share the parent's wrapper, which stays
    // unmarked.
    expect(parentWrapper).not.toBe(originalWork);
    expect(marked(parentWrapper)).toBe(false);
  });
});
