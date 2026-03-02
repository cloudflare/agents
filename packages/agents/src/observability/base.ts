/**
 * Base event structure for all observability events
 */
export type BaseEvent<
  T extends string,
  Payload extends Record<string, unknown> = Record<string, never>
> = {
  type: T;
  /**
   * The class name of the agent that emitted this event
   * (e.g. "MyChatAgent").
   * Always present on events emitted by an Agent instance.
   */
  agent?: string;
  /**
   * The instance name (Durable Object ID name) of the agent.
   * Always present on events emitted by an Agent instance.
   */
  name?: string;
  /**
   * The payload of the event
   */
  payload: Payload;
  /**
   * The timestamp of the event in milliseconds since epoch
   */
  timestamp: number;
};
