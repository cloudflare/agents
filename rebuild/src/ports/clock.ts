/** Source of the current time. Domain code never calls Date.now() directly. */
export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
};
