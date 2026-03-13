/**
 * Pre-captured performance API reference.
 */

export const _performanceNow: () => number =
  typeof performance !== "undefined"
    ? performance.now.bind(performance)
    : Date.now;
