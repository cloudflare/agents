// Primitive types that are always serializable
type SerializablePrimitive = undefined | null | string | number | boolean;

// Types that can NEVER be serialized to JSON
// Includes Function, symbol, bigint, and built-in object types that don't
// serialize properly (Date becomes a string, but we want to reject it
// because it doesn't round-trip correctly)
type NonSerializable =
  | Function
  | symbol
  | bigint
  | Date
  | RegExp
  | Map<unknown, unknown>
  | Set<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>
  | Error
  | ArrayBuffer
  | SharedArrayBuffer
  | DataView
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

// Depth-limiting helpers to prevent "Type instantiation is excessively deep"
// errors with deeply nested types (e.g. AI SDK CoreMessage[]).
// After MaxDepth levels without hitting a NonSerializable type, we bail out
// and assume the type is serializable.
type MaxDepth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 10 levels
type Increment<D extends unknown[]> = [0, ...D];
type IsMaxDepth<D extends unknown[]> = D["length"] extends MaxDepth["length"]
  ? true
  : false;

// Legacy type for backward compatibility
export type SerializableValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | { [key: string]: SerializableValue }
  | SerializableValue[];

// Recursive type to check if a value can be serialized to JSON
// This is more permissive than SerializableValue because it accepts
// interfaces with named properties (not just index signatures)
type CanSerialize<T, Seen = never, Depth extends unknown[] = []> =
  // Bail out at max depth — assume serializable if we haven't hit a
  // NonSerializable type after 10 levels of recursion
  IsMaxDepth<Depth> extends true
    ? true
    : // Prevent infinite recursion with seen types
      T extends Seen
      ? true
      : // Primitives are always serializable
        T extends SerializablePrimitive
        ? true
        : // Functions, symbols, bigints are never serializable
          T extends NonSerializable
          ? false
          : // Arrays: check if element type is serializable
            T extends readonly (infer U)[]
            ? CanSerialize<U, Seen | T, Increment<Depth>>
            : // Objects: check if all property values are serializable
              T extends object
              ? unknown extends T
                ? true // unknown is allowed (for generic returns)
                : {
                      [K in keyof T]: CanSerialize<
                        T[K],
                        Seen | T,
                        Increment<Depth>
                      >;
                    } extends { [K in keyof T]: true }
                  ? true
                  : false
              : // Anything else, be permissive
                true;

// Check if a return value can be serialized (including void and Promises)
type CanSerializeReturn<T> = T extends void
  ? true
  : T extends Promise<infer U>
    ? CanSerialize<U>
    : CanSerialize<T>;

export type SerializableReturnValue =
  | SerializableValue
  | void
  | Promise<SerializableValue>
  | Promise<void>;

// Check if a single value is serializable (for parameters)
// Uses the same recursive logic as CanSerialize
type IsSerializableParam<T, Seen = never, Depth extends unknown[] = []> =
  IsMaxDepth<Depth> extends true
    ? true
    : T extends Seen
      ? true
      : T extends SerializablePrimitive
        ? true
        : T extends NonSerializable
          ? false
          : T extends readonly (infer U)[]
            ? IsSerializableParam<U, Seen | T, Increment<Depth>>
            : T extends object
              ? unknown extends T
                ? true
                : {
                      [K in keyof T]: IsSerializableParam<
                        T[K],
                        Seen | T,
                        Increment<Depth>
                      >;
                    } extends {
                      [K in keyof T]: true;
                    }
                  ? true
                  : false
              : true;

type AllSerializableValues<A> = A extends [infer First, ...infer Rest]
  ? IsSerializableParam<First> extends true
    ? AllSerializableValues<Rest>
    : false
  : true; // no params means serializable by default

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic callable type
export type Method = (...args: any[]) => any;

// Helper to check if a type is exactly unknown
// unknown extends T is true only if T is unknown or any
// We also need [T] extends [unknown] to handle distribution
type IsUnknown<T> = [unknown] extends [T]
  ? [T] extends [unknown]
    ? true
    : false
  : false;

// Helper to unwrap Promise and check if the inner type is unknown
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

export type RPCMethod<T = Method> = T extends Method
  ? T extends (...arg: infer A) => infer R
    ? AllSerializableValues<A> extends true
      ? CanSerializeReturn<R> extends true
        ? T
        : IsUnknown<UnwrapPromise<R>> extends true
          ? T
          : never
      : never
    : never
  : never;
