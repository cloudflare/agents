import { expectTypeOf } from "vitest";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type DurableObjectCapability
} from "../lifecycle";

// The capability runner awaits onStart, so the base hook allows a promise.
expectTypeOf<
  ReturnType<LifecycleCapability["onStart"]>
>().toEqualTypeOf<void | Promise<void>>();
expectTypeOf<ReturnType<LifecycleCapability["onStart"]>>().toEqualTypeOf<
  ReturnType<NonNullable<DurableObjectCapability["onStart"]>>
>();

class AsyncStartCapability extends LifecycleCapability<{ ready: boolean }> {
  constructor() {
    super("async-start-probe");
  }

  override async onStart(
    context: CapabilityStartContext<{ ready: boolean }>
  ): Promise<void> {
    await super.onStart(context);
    expectTypeOf(context.props).toEqualTypeOf<{ ready: boolean } | undefined>();
  }
}

class SyncStartCapability extends LifecycleCapability {
  constructor() {
    super("sync-start-probe");
  }

  override onStart(): void {}
}

new AsyncStartCapability() satisfies DurableObjectCapability;
new SyncStartCapability() satisfies DurableObjectCapability;
expectTypeOf<ReturnType<AsyncStartCapability["onStart"]>>().toEqualTypeOf<
  Promise<void>
>();
