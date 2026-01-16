export type SerializableValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | { [key: string]: SerializableValue }
  | SerializableValue[];

export type SerializableReturnValue =
  | SerializableValue
  | void
  | Promise<SerializableValue>
  | Promise<void>;

type AllSerializableValues<A> = A extends [infer First, ...infer Rest]
  ? First extends SerializableValue
    ? AllSerializableValues<Rest>
    : false
  : true; // no params means serializable by default

// biome-ignore lint: suspicious/noExplicitAny
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
      ? R extends SerializableReturnValue
        ? T
        : IsUnknown<UnwrapPromise<R>> extends true
          ? T
          : never
      : never
    : never
  : never;
