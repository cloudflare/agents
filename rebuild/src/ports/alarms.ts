/**
 * A Durable Object gives exactly one alarm slot; higher-level schedulers
 * multiplex on top of it. This port is that raw slot.
 */
export interface AlarmTimer {
  /** Replaces any previously set alarm. */
  set(at: number): void;
  get(): number | null;
  clear(): void;
}
