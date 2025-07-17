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

export type RPCMethod<T = Method> = T extends Method
  ? T extends (...arg: infer A) => infer R
    ? AllSerializableValues<A> extends true
      ? R extends SerializableReturnValue
        ? T
        : never
      : never
    : never
  : never;
