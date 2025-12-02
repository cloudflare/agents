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

export type AllSerializableValues<A> = A extends [infer First, ...infer Rest]
  ? First extends SerializableValue
    ? AllSerializableValues<Rest>
    : false
  : true; // no params means serializable by default
