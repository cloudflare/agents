import type { JsonValue, SubmissionInput } from "./submissions";

/** Compare the immutable execution input selected by an idempotency key. */
export function equivalentSubmissionInput(
  left: SubmissionInput,
  right: SubmissionInput
): boolean {
  return (
    left.agentTarget === right.agentTarget &&
    equalJson(left.payload, right.payload) &&
    left.source.type === right.source.type &&
    left.source.id === right.source.id &&
    left.conversationHint === right.conversationHint
  );
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  }

  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && equalJson(left[key], right[key])
    )
  );
}
