import { MachineSerializationError } from "./errors";

export const MAX_MACHINE_CHECKPOINT_BYTES = 1_048_576;
const utf8 = new TextEncoder();

export function serializeMachineValue(
  value: unknown,
  context: string
): string | null {
  if (value === undefined) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new MachineSerializationError(context, String(cause));
  }
  if (json === undefined) {
    throw new MachineSerializationError(
      context,
      `value of type ${typeof value} has no JSON representation`
    );
  }
  const bytes = utf8.encode(json).byteLength;
  if (bytes > MAX_MACHINE_CHECKPOINT_BYTES) {
    throw new MachineSerializationError(
      context,
      `serialized size ${bytes} exceeds ${MAX_MACHINE_CHECKPOINT_BYTES} bytes`
    );
  }
  return json;
}

export function deserializeMachineValue(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}
