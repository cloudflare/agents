/**
 * Parse a duration string (e.g. "5s", "1m", "2h", "1d") to milliseconds.
 * Returns null if the string is not a valid duration.
 */
export function parseDuration(arg: string): number | null {
  const match = arg.match(/^(\d+\.?\d*)(s|m|h|d)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const suffix = match[2] || "s";

  switch (suffix) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}
