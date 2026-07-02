/** Narrows an unknown value to a string. */
export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Narrows an unknown value to a number. */
export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** AI SDK token counts are either a plain number or `{ total?: number, ... }`. */
export function readTokenCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    // SAFETY: AI SDK nested token count has a numeric total field.
    const total = (value as Record<string, unknown>).total;
    return typeof total === "number" ? total : undefined;
  }

  return undefined;
}

/** Reads a numeric sub-field from a nested AI SDK token count object. */
export function readNestedTokenField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK nested token count has known numeric sub-fields.
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "number" ? nested : undefined;
}
