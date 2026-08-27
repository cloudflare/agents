/** Fixed transfer category safe to expose in Run error details. */
export type RunDataPath =
  | "hostFunction.arguments"
  | "hostFunction.result"
  | "result";

/** Result of parsing one graph against Run's ordinary-data contract. */
export type RunDataParseResult<
  Value = unknown,
  Path extends RunDataPath = RunDataPath
> =
  | { readonly status: "accepted"; readonly value: Value }
  | { readonly status: "rejected"; readonly path: Path };

const runDataArrayIsArray = Array.isArray;
const runArrayPop = Array.prototype.pop;
const runDataArrayPush = Array.prototype.push;
const runArrayPrototype = Array.prototype;
const runArrayBufferPrototype = ArrayBuffer.prototype;
const runDataViewPrototype = DataView.prototype;
const runDateGetTime = Date.prototype.getTime;
const runDatePrototype = Date.prototype;
const runMapForEach = Map.prototype.forEach;
const runMapPrototype = Map.prototype;
const runNumber = Number;
const runNumberIsInteger = Number.isInteger;
const runObjectHasOwn = Object.hasOwn;
const runObjectPrototype = Object.prototype;
const runDataReflectApply = Reflect.apply;
const runReflectGet = Reflect.get;
const runReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const runReflectGetPrototypeOf = Reflect.getPrototypeOf;
const runReflectOwnKeys = Reflect.ownKeys;
const runRegExpPrototype = RegExp.prototype;
const runSetAdd = Set.prototype.add;
const runSetForEach = Set.prototype.forEach;
const runSetHas = Set.prototype.has;
const runSetPrototype = Set.prototype;
const runDataString = String;
const RunDataWeakSet = WeakSet;
const runStructuredClone = structuredClone;
const runWeakSetAdd = WeakSet.prototype.add;
const runWeakSetHas = WeakSet.prototype.has;

const runTypedArrayPrototypes = new Set<object>([
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype
]);
const runFloat16ArrayConstructor = runDataReflectApply(
  runReflectGet,
  undefined,
  [globalThis, "Float16Array"]
);
if (typeof runFloat16ArrayConstructor === "function") {
  const runFloat16ArrayPrototype = runDataReflectApply(
    runReflectGet,
    undefined,
    [runFloat16ArrayConstructor, "prototype"]
  );
  if (
    typeof runFloat16ArrayPrototype === "object" &&
    runFloat16ArrayPrototype !== null
  ) {
    runDataReflectApply(runSetAdd, runTypedArrayPrototypes, [
      runFloat16ArrayPrototype
    ]);
  }
}

function getRunIntrinsicGetter(
  prototype: object,
  property: string
): (this: object) => unknown {
  const getter = runReflectGetOwnPropertyDescriptor(prototype, property)?.get;
  if (getter === undefined) {
    throw new Error("Run data intrinsic getter is unavailable.");
  }
  return getter;
}

const runArrayBufferByteLengthGetter = getRunIntrinsicGetter(
  runArrayBufferPrototype,
  "byteLength"
);
const runDataViewBufferGetter = getRunIntrinsicGetter(
  runDataViewPrototype,
  "buffer"
);
const runRegExpSourceGetter = getRunIntrinsicGetter(
  runRegExpPrototype,
  "source"
);
const runTypedArrayBasePrototype = runReflectGetPrototypeOf(
  Uint8Array.prototype
);
if (runTypedArrayBasePrototype === null) {
  throw new Error("Run typed array prototype is unavailable.");
}
const runTypedArrayBufferGetter = getRunIntrinsicGetter(
  runTypedArrayBasePrototype,
  "buffer"
);
const runTypedArrayLengthGetter = getRunIntrinsicGetter(
  runTypedArrayBasePrototype,
  "length"
);

function pushRunDataValue(values: unknown[], value: unknown): void {
  runDataReflectApply(runDataArrayPush, values, [value]);
}

function popRunDataValue(values: unknown[]): unknown {
  return runDataReflectApply(runArrayPop, values, []);
}

function hasSeenRunDataValue(seen: WeakSet<object>, value: object): boolean {
  return runDataReflectApply(runWeakSetHas, seen, [value]);
}

function markRunDataValueSeen(seen: WeakSet<object>, value: object): void {
  runDataReflectApply(runWeakSetAdd, seen, [value]);
}

function hasEnumerableInheritedRunDataProperty(
  prototype: object | null
): boolean {
  for (
    let current = prototype;
    current !== null;
    current = runReflectGetPrototypeOf(current)
  ) {
    for (const property of runReflectOwnKeys(current)) {
      if (
        runReflectGetOwnPropertyDescriptor(current, property)?.enumerable ===
        true
      ) {
        return true;
      }
    }
  }
  return false;
}

function appendRunPlainObjectValues(value: object, values: unknown[]): boolean {
  for (const property of runReflectOwnKeys(value)) {
    if (typeof property !== "string") return false;
    const descriptor = runReflectGetOwnPropertyDescriptor(value, property);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !runObjectHasOwn(descriptor, "value")
    ) {
      return false;
    }
    pushRunDataValue(values, descriptor.value);
  }
  return true;
}

function isRunArrayIndex(property: string, length: number): boolean {
  if (property.length === 0) return false;
  const index = runNumber(property);
  return (
    runNumberIsInteger(index) &&
    index >= 0 &&
    index < length &&
    runDataString(index) === property
  );
}

function appendRunArrayValues(value: object, values: unknown[]): boolean {
  const lengthDescriptor = runReflectGetOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !runObjectHasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number"
  ) {
    return false;
  }

  for (const property of runReflectOwnKeys(value)) {
    if (property === "length") continue;
    if (
      typeof property !== "string" ||
      !isRunArrayIndex(property, lengthDescriptor.value)
    ) {
      return false;
    }
    const descriptor = runReflectGetOwnPropertyDescriptor(value, property);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !runObjectHasOwn(descriptor, "value")
    ) {
      return false;
    }
    pushRunDataValue(values, descriptor.value);
  }
  return true;
}

function hasNoRunDataOwnProperties(value: object): boolean {
  return runReflectOwnKeys(value).length === 0;
}

function hasOnlyRunRegExpState(value: object): boolean {
  const properties = runReflectOwnKeys(value);
  if (properties.length !== 1 || properties[0] !== "lastIndex") return false;
  const descriptor = runReflectGetOwnPropertyDescriptor(value, "lastIndex");
  return (
    descriptor !== undefined &&
    !descriptor.enumerable &&
    runObjectHasOwn(descriptor, "value") &&
    typeof descriptor.value === "number"
  );
}

function appendRunTypedArrayValues(value: object, values: unknown[]): boolean {
  const length = runDataReflectApply(runTypedArrayLengthGetter, value, []);
  if (typeof length !== "number") return false;

  for (const property of runReflectOwnKeys(value)) {
    if (typeof property !== "string" || !isRunArrayIndex(property, length)) {
      return false;
    }
    const descriptor = runReflectGetOwnPropertyDescriptor(value, property);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !runObjectHasOwn(descriptor, "value")
    ) {
      return false;
    }
    pushRunDataValue(values, descriptor.value);
  }
  pushRunDataValue(
    values,
    runDataReflectApply(runTypedArrayBufferGetter, value, [])
  );
  return true;
}

/** Parse and prepare a graph for native Workers RPC ordinary-data transfer. */
function parseRunData<Value, Path extends RunDataPath>(
  value: Value,
  path: Path
): RunDataParseResult<Value, Path> {
  const values = [value];
  const seen = new RunDataWeakSet<object>();
  let requiresNullPrototypeClone = false;

  try {
    while (values.length > 0) {
      const current = popRunDataValue(values);
      if (
        current === null ||
        current === undefined ||
        typeof current === "boolean" ||
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "bigint"
      ) {
        continue;
      }
      if (typeof current !== "object") return { status: "rejected", path };
      if (hasSeenRunDataValue(seen, current)) continue;
      markRunDataValueSeen(seen, current);

      const prototype = runReflectGetPrototypeOf(current);
      if (hasEnumerableInheritedRunDataProperty(prototype)) {
        return { status: "rejected", path };
      }
      if (prototype === null || prototype === runObjectPrototype) {
        if (!appendRunPlainObjectValues(current, values)) {
          return { status: "rejected", path };
        }
        requiresNullPrototypeClone ||= prototype === null;
        continue;
      }
      if (runDataArrayIsArray(current)) {
        if (
          prototype !== runArrayPrototype ||
          !appendRunArrayValues(current, values)
        ) {
          return { status: "rejected", path };
        }
        continue;
      }
      if (prototype === runDatePrototype) {
        if (!hasNoRunDataOwnProperties(current)) {
          return { status: "rejected", path };
        }
        runDataReflectApply(runDateGetTime, current, []);
        continue;
      }
      if (prototype === runRegExpPrototype) {
        if (!hasOnlyRunRegExpState(current)) {
          return { status: "rejected", path };
        }
        runDataReflectApply(runRegExpSourceGetter, current, []);
        continue;
      }
      if (prototype === runMapPrototype) {
        if (!hasNoRunDataOwnProperties(current)) {
          return { status: "rejected", path };
        }
        runDataReflectApply(runMapForEach, current, [
          (entryValue: unknown, entryKey: unknown) => {
            pushRunDataValue(values, entryKey);
            pushRunDataValue(values, entryValue);
          }
        ]);
        continue;
      }
      if (prototype === runSetPrototype) {
        if (!hasNoRunDataOwnProperties(current)) {
          return { status: "rejected", path };
        }
        runDataReflectApply(runSetForEach, current, [
          (entryValue: unknown) => pushRunDataValue(values, entryValue)
        ]);
        continue;
      }
      if (prototype === runArrayBufferPrototype) {
        if (!hasNoRunDataOwnProperties(current)) {
          return { status: "rejected", path };
        }
        runDataReflectApply(runArrayBufferByteLengthGetter, current, []);
        continue;
      }
      if (prototype === runDataViewPrototype) {
        if (!hasNoRunDataOwnProperties(current)) {
          return { status: "rejected", path };
        }
        pushRunDataValue(
          values,
          runDataReflectApply(runDataViewBufferGetter, current, [])
        );
        continue;
      }
      if (
        runDataReflectApply(runSetHas, runTypedArrayPrototypes, [prototype])
      ) {
        if (!appendRunTypedArrayValues(current, values)) {
          return { status: "rejected", path };
        }
        continue;
      }
      return { status: "rejected", path };
    }

    if (requiresNullPrototypeClone) {
      // ponytail: Workers RPC rejects null-prototype objects; remove this native clone when it accepts them directly.
      return {
        status: "accepted",
        // SAFETY: Native structured clone preserves the accepted graph's value types.
        value: runDataReflectApply(runStructuredClone, undefined, [
          value
        ]) as Value
      };
    }
    return { status: "accepted", value };
  } catch {
    return { status: "rejected", path };
  }
}

export { parseRunData };
