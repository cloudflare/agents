import { describe, it, expect } from "vitest";
import { AbortRegistry } from "../abort-registry";

describe("AbortRegistry", () => {
  it("creates a controller lazily on getSignal", () => {
    const registry = new AbortRegistry();
    expect(registry.has("r1")).toBe(false);

    const signal = registry.getSignal("r1");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(registry.has("r1")).toBe(true);
  });

  it("returns the same signal on repeated getSignal calls", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    const s2 = registry.getSignal("r1");
    expect(s1).toBe(s2);
  });

  it("returns undefined for non-string ids", () => {
    const registry = new AbortRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(registry.getSignal(123 as any)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(registry.getSignal(null as any)).toBeUndefined();
  });

  it("getExistingSignal returns undefined when no controller exists", () => {
    const registry = new AbortRegistry();
    expect(registry.getExistingSignal("r1")).toBeUndefined();
  });

  it("getExistingSignal returns signal after getSignal creates it", () => {
    const registry = new AbortRegistry();
    const signal = registry.getSignal("r1");
    expect(registry.getExistingSignal("r1")).toBe(signal);
  });

  it("cancel aborts the controller's signal", () => {
    const registry = new AbortRegistry();
    const signal = registry.getSignal("r1");
    expect(signal!.aborted).toBe(false);

    registry.cancel("r1");
    expect(signal!.aborted).toBe(true);
  });

  it("cancel is a no-op for unknown ids", () => {
    const registry = new AbortRegistry();
    expect(() => registry.cancel("unknown")).not.toThrow();
  });

  it("remove deletes the controller", () => {
    const registry = new AbortRegistry();
    registry.getSignal("r1");
    expect(registry.has("r1")).toBe(true);

    registry.remove("r1");
    expect(registry.has("r1")).toBe(false);
    expect(registry.getExistingSignal("r1")).toBeUndefined();
  });

  it("destroyAll aborts all controllers and clears the registry", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    const s2 = registry.getSignal("r2");
    const s3 = registry.getSignal("r3");

    registry.destroyAll();

    expect(s1!.aborted).toBe(true);
    expect(s2!.aborted).toBe(true);
    expect(s3!.aborted).toBe(true);
    expect(registry.has("r1")).toBe(false);
    expect(registry.has("r2")).toBe(false);
    expect(registry.has("r3")).toBe(false);
  });

  it("getSignal creates a fresh controller after remove", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    registry.cancel("r1");
    registry.remove("r1");

    const s2 = registry.getSignal("r1");
    expect(s2).not.toBe(s1);
    expect(s2!.aborted).toBe(false);
  });

  it("size reflects the number of tracked controllers", () => {
    const registry = new AbortRegistry();
    expect(registry.size).toBe(0);

    registry.getSignal("r1");
    expect(registry.size).toBe(1);

    registry.getSignal("r2");
    expect(registry.size).toBe(2);

    registry.remove("r1");
    expect(registry.size).toBe(1);

    registry.destroyAll();
    expect(registry.size).toBe(0);
  });

  it("cancel forwards the optional reason onto the controller's signal", () => {
    const registry = new AbortRegistry();
    const signal = registry.getSignal("r1");
    const reason = new Error("user cancelled");

    registry.cancel("r1", reason);

    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe(reason);
  });
});

describe("AbortRegistry.linkExternal", () => {
  it("returns a no-op detacher when signal is undefined", () => {
    const registry = new AbortRegistry();
    const detach = registry.linkExternal("r1", undefined);
    expect(typeof detach).toBe("function");
    expect(() => detach()).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it("cancels the registry controller synchronously when the external signal is already aborted", () => {
    const registry = new AbortRegistry();
    const external = AbortSignal.abort(new Error("already gone"));

    const detach = registry.linkExternal("r1", external);

    // Controller is created (so downstream getExistingSignal observers
    // see the cancelled state) and is aborted with the external reason.
    const internal = registry.getExistingSignal("r1");
    expect(internal).toBeInstanceOf(AbortSignal);
    expect(internal!.aborted).toBe(true);
    expect((internal!.reason as Error).message).toBe("already gone");

    expect(() => detach()).not.toThrow();
  });

  it("cancels the registry controller when the external signal aborts later", () => {
    const registry = new AbortRegistry();
    const internal = registry.getSignal("r1");
    expect(internal!.aborted).toBe(false);

    const controller = new AbortController();
    const detach = registry.linkExternal("r1", controller.signal);

    expect(internal!.aborted).toBe(false);

    const reason = new Error("external cancel");
    controller.abort(reason);

    expect(internal!.aborted).toBe(true);
    expect(internal!.reason).toBe(reason);

    detach();
  });

  it("the returned detacher removes the listener so post-detach aborts do not affect the registry", () => {
    const registry = new AbortRegistry();
    const internal = registry.getSignal("r1");
    const controller = new AbortController();
    const detach = registry.linkExternal("r1", controller.signal);

    detach();

    // After detach, the external abort must NOT cascade into the
    // registry. We simulate the post-completion path: the request id
    // was removed from the registry, then the long-lived parent signal
    // aborts. With the listener still attached, `cancel(id)` would
    // still fire (harmless because the controller is gone), but
    // critically the listener itself should be gone — verify by
    // freshly inserting a controller with the same id and checking it
    // remains un-aborted.
    registry.remove("r1");
    const fresh = registry.getSignal("r1");
    expect(fresh).not.toBe(internal);

    controller.abort(new Error("external aborted after detach"));

    expect(fresh!.aborted).toBe(false);
  });

  it("multiple linked ids are independent", () => {
    const registry = new AbortRegistry();
    const s1 = registry.getSignal("r1");
    const s2 = registry.getSignal("r2");

    const c1 = new AbortController();
    const c2 = new AbortController();

    const detach1 = registry.linkExternal("r1", c1.signal);
    const detach2 = registry.linkExternal("r2", c2.signal);

    c1.abort(new Error("only r1"));

    expect(s1!.aborted).toBe(true);
    expect(s2!.aborted).toBe(false);

    detach1();
    detach2();
  });

  it("linking the same id twice and aborting both externals only cancels once with the first reason", () => {
    const registry = new AbortRegistry();
    const internal = registry.getSignal("r1");

    const c1 = new AbortController();
    const c2 = new AbortController();

    registry.linkExternal("r1", c1.signal);
    registry.linkExternal("r1", c2.signal);

    c1.abort(new Error("first"));
    expect(internal!.aborted).toBe(true);
    expect((internal!.reason as Error).message).toBe("first");

    // Second abort attempts to cancel an already-aborted controller —
    // signal.reason is preserved as the first reason (Web Platform
    // semantics for AbortController.abort: subsequent calls are no-ops).
    c2.abort(new Error("second"));
    expect((internal!.reason as Error).message).toBe("first");
  });

  it("listener is removed once via { once: true } so a re-aborted external does not double-cancel", () => {
    const registry = new AbortRegistry();
    registry.getSignal("r1");
    const c1 = new AbortController();
    registry.linkExternal("r1", c1.signal);

    let cancelCalls = 0;
    const originalCancel = registry.cancel.bind(registry);
    registry.cancel = (id: string, reason?: unknown) => {
      if (id === "r1") cancelCalls++;
      originalCancel(id, reason);
    };

    c1.abort(new Error("once"));
    // dispatching abort a second time on the same controller is a
    // no-op at the platform level, but verify our listener doesn't
    // re-fire either:
    c1.signal.dispatchEvent(new Event("abort"));

    expect(cancelCalls).toBe(1);
  });

  it("a single long-lived external signal can drive many sequential turns without leaking listeners", () => {
    const registry = new AbortRegistry();
    const controller = new AbortController();
    const signal = controller.signal;

    // Mirror the helper-as-sub-agent pattern: many sequential
    // turns share one parent signal. After each turn finishes,
    // the detacher must remove its listener.
    let attached = 0;
    let removed = 0;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (
      type: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options?: any
    ) => {
      if (type === "abort") attached++;
      originalAdd(type, listener, options);
    };
    signal.removeEventListener = (
      type: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options?: any
    ) => {
      if (type === "abort") removed++;
      originalRemove(type, listener, options);
    };

    for (let i = 0; i < 100; i++) {
      const id = `r-${i}`;
      registry.getSignal(id);
      const detach = registry.linkExternal(id, signal);
      detach();
      registry.remove(id);
    }

    expect(attached).toBe(100);
    expect(removed).toBe(100);
    // No controllers leaked into the registry.
    expect(registry.size).toBe(0);
  });

  it("works when the external signal is consumed concurrently by multiple linked ids and aborts once", () => {
    const registry = new AbortRegistry();
    const ids = ["a", "b", "c", "d", "e"];
    const signals = ids.map((id) => registry.getSignal(id));
    const controller = new AbortController();
    const detachers = ids.map((id) =>
      registry.linkExternal(id, controller.signal)
    );

    expect(signals.every((s) => !s!.aborted)).toBe(true);

    controller.abort(new Error("multi-cancel"));

    for (const s of signals) {
      expect(s!.aborted).toBe(true);
      expect((s!.reason as Error).message).toBe("multi-cancel");
    }

    // Detachers MUST be safe to call after the listeners already
    // fired (each was registered with `{ once: true }`).
    detachers.forEach((d) => expect(() => d()).not.toThrow());
  });

  it("internal cancel and external abort coexist — internal first, external after detach is a no-op", () => {
    const registry = new AbortRegistry();
    const internal = registry.getSignal("r1")!;
    const controller = new AbortController();
    const detach = registry.linkExternal("r1", controller.signal);

    // Internal cancel (e.g. from MSG_CHAT_CANCEL) fires first.
    registry.cancel("r1", new Error("internal cancel"));
    expect(internal.aborted).toBe(true);
    expect((internal.reason as Error).message).toBe("internal cancel");

    // After the request finishes, the inner finally detaches and
    // removes the controller. By that point the external signal
    // is irrelevant — but if it does fire later, it must NOT
    // resurrect anything.
    detach();
    registry.remove("r1");

    controller.abort(new Error("late external abort"));
    expect(registry.has("r1")).toBe(false);
    expect(registry.size).toBe(0);
  });
});
