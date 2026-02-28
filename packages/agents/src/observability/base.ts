/**
 * Base event structure for all observability events
 */
export type BaseEvent<
  T extends string,
  Payload extends Record<string, unknown> = Record<string, never>
> = {
  type: T;
  /**
   * The payload of the event
   */
  payload: Payload;
  /**
   * The timestamp of the event in milliseconds since epoch
   */
  timestamp: number;
};
