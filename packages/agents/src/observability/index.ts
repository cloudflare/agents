import { getCurrentAgent } from "../index";

type BaseEvent<
  T extends string,
  Payload extends Record<string, unknown> = {}
> = {
  type: T;
  /**
   * The unique identifier for the event
   */
  id: string;
  /**
   * The message to display in the logs for this event, should the implementation choose to display
   * a human-readable message.
   */
  displayMessage: string;
  /**
   * The payload of the event
   */
  payload: Payload;
  /**
   * The timestamp of the event in milliseconds since epoch
   */
  timestamp: number;
};

/**
 * The type of events that can be emitted by an Agent
 */
export type ObservabilityEvent =
  | BaseEvent<"state:update", {}>
  | BaseEvent<
      "rpc",
      {
        method: string;
        streaming?: boolean;
      }
    >
  | BaseEvent<"message:request" | "message:response", {}>
  | BaseEvent<"message:clear">
  | BaseEvent<
      "schedule:create" | "schedule:execute" | "schedule:cancel",
      {
        callback: string;
        id: string;
      }
    >
  | BaseEvent<"destroy">
  | BaseEvent<
      "connect",
      {
        connectionId: string;
      }
    >;

export interface Observability {
  /**
   * Emit an event for the Agent's observability implementation to handle.
   * @param event - The event to emit
   * @param ctx - The execution context of the invocation
   */
  emit(event: ObservabilityEvent, ctx: DurableObjectState): void;
}

/**
 * A generic observability implementation that logs events to the console.
 */
export const genericObservability: Observability = {
  emit(event) {
    // In local mode, we display a pretty-print version of the event for easier debugging.
    if (isLocalMode()) {
      console.log(event.displayMessage);
      return;
    }

    console.log(event);
  }
};

let localMode = false;

function isLocalMode() {
  if (localMode) {
    return true;
  }
  const { request } = getCurrentAgent();
  if (!request) {
    return false;
  }

  const url = new URL(request.url);
  localMode = url.hostname === "localhost";
  return localMode;
}
