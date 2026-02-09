/**
 * Base event structure for all observability events
 */
export type BaseEvent<
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
  payload: Payload & Record<string, unknown>;
  /**
   * The timestamp of the event in milliseconds since epoch
   */
  timestamp: number;
};
