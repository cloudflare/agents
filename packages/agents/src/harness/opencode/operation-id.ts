const OPERATION_ID = /^[A-Za-z0-9._~-]+$/;

/** OpenCode's id for the user message an operation submits. */
export function messageIdOf(operationId: string): string {
  if (!OPERATION_ID.test(operationId)) {
    throw new TypeError(
      `Invalid operation id ${JSON.stringify(operationId)}: use letters, digits, ".", "_", "~" and "-"`
    );
  }
  return `msg_${operationId}`;
}

/** The operation id of a message or inbox item, the inverse of `messageIdOf`. */
export function operationIdOf(messageId: string): string {
  return messageId.startsWith("msg_") ? messageId.slice(4) : messageId;
}
