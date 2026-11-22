/**
 * Whether a subclass declared a method itself. `Agent` wraps subclass
 * methods during `super()`, copying inherited methods onto the concrete
 * prototype, so a plain prototype lookup cannot tell a user override from a
 * framework-installed wrapper. The prototype chain is snapshotted before
 * `super()` runs, and later checks read the snapshot.
 */

export interface DeclaredOverrides {
  /** Record the members each prototype below the base declares. Call before `super()`. */
  snapshot(prototype: object): void;
  /** Whether `instance`'s class (below the base) declares `methodName`. */
  isOverridden(instance: object, methodName: string): boolean;
}

/** Track overrides of the methods of `base()` (read lazily). */
export function declaredOverrides(base: () => object): DeclaredOverrides {
  const declared = new WeakMap<object, ReadonlySet<PropertyKey>>();
  return {
    snapshot(prototype) {
      for (
        let current: object | null = prototype;
        current && current !== base();
        current = Object.getPrototypeOf(current) as object | null
      ) {
        if (!declared.has(current)) {
          declared.set(current, new Set(Reflect.ownKeys(current)));
        }
      }
    },
    isOverridden(instance, methodName) {
      // Agent's auto-wrapper writes to the concrete prototype, not the
      // instance; an own member here is a subclass class-field override
      // initialized later.
      if (Object.prototype.hasOwnProperty.call(instance, methodName)) {
        return true;
      }
      for (
        let current: object | null = Object.getPrototypeOf(instance) as object;
        current && current !== base();
        current = Object.getPrototypeOf(current) as object | null
      ) {
        if (declared.get(current)?.has(methodName)) return true;
      }
      return false;
    }
  };
}
