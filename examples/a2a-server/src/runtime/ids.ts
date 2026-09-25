const MAX_CONTEXT_ID_BYTES = 45;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Enforces this runtime's context limit for reversible task routing. */
export function validateContextId(contextId: string): string {
  if (!contextId) throw new Error("contextId is required");
  if (!isWellFormedUtf16(contextId)) {
    throw new Error("contextId must be well-formed UTF-16");
  }
  if (new TextEncoder().encode(contextId).byteLength > MAX_CONTEXT_ID_BYTES) {
    throw new Error(
      `contextId must be at most ${MAX_CONTEXT_ID_BYTES} UTF-8 bytes`
    );
  }
  return contextId;
}

/** Mints a task ID that carries a reversible context-routing prefix. */
export function mintTaskId(contextId: string): string {
  return `${encodeContextId(validateContextId(contextId))}-${crypto.randomUUID()}`;
}

/** Derives a stable, fixed-length Workflow ID from a server-issued task ID. */
export function workflowInstanceId(taskId: string, turn: number): string {
  contextIdFromTaskId(taskId);
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    throw new Error("Workflow turn must be a positive safe integer");
  }
  const nonce = taskId.slice(-36).replaceAll("-", "");
  return `a2a_${nonce}_turn_${turn}`;
}

/** Recovers and validates the context ID embedded in a server-issued task ID. */
export function contextIdFromTaskId(taskId: string): string {
  const separator = taskId.length - 37;
  if (
    separator <= 0 ||
    taskId[separator] !== "-" ||
    !UUID_PATTERN.test(taskId.slice(separator + 1))
  ) {
    throw new Error("taskId is not a server-issued task identifier");
  }
  try {
    return validateContextId(decodeContextId(taskId.slice(0, separator)));
  } catch {
    throw new Error("taskId is not a server-issued task identifier");
  }
}

function encodeContextId(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeContextId(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0)
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
