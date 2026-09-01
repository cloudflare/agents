// Adapted to ESM from partial-json 0.1.7.
// Copyright (c) 2023 Promplate Dev Team. MIT licensed.

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const ALLOW_STRING = 0b000000001;
const ALLOW_NUMBER = 0b000000010;
const ALLOW_ARRAY = 0b000000100;
const ALLOW_OBJECT = 0b000001000;
const ALLOW_NULL = 0b000010000;
const ALLOW_BOOLEAN = 0b000100000;
const ALLOW_NAN = 0b001000000;
const ALLOW_INFINITY = 0b010000000;
const ALLOW_NEGATIVE_INFINITY = 0b100000000;
const ALLOW_ALL =
  ALLOW_STRING |
  ALLOW_NUMBER |
  ALLOW_ARRAY |
  ALLOW_OBJECT |
  ALLOW_NULL |
  ALLOW_BOOLEAN |
  ALLOW_NAN |
  ALLOW_INFINITY |
  ALLOW_NEGATIVE_INFINITY;

class PartialJsonError extends Error {}
class MalformedJsonError extends Error {}

/** Parse a JSON value while retaining complete portions of an incomplete input. */
export function parse(input: string): JsonValue {
  if (typeof input !== "string") {
    throw new TypeError(`Expected a string, received ${typeof input}`);
  }
  const source = input.trim();
  if (source === "") throw new Error("Cannot parse empty JSON");

  let index = 0;
  const partial = (message: string): never => {
    throw new PartialJsonError(`${message} at position ${index}`);
  };
  const malformed = (message: string): never => {
    throw new MalformedJsonError(`${message} at position ${index}`);
  };
  const skipWhitespace = (): void => {
    while (index < source.length && " \n\r\t".includes(source[index])) index++;
  };

  const parseString = (): string => {
    const start = index;
    let escaped = false;
    index++;
    while (
      index < source.length &&
      (source[index] !== '"' || (escaped && source[index - 1] === "\\"))
    ) {
      escaped = source[index] === "\\" ? !escaped : false;
      index++;
    }
    if (source[index] === '"') {
      try {
        return JSON.parse(
          source.slice(start, ++index - Number(escaped))
        ) as string;
      } catch (error) {
        malformed(String(error));
      }
    }
    if ((ALLOW_STRING & ALLOW_ALL) !== 0) {
      try {
        return JSON.parse(
          `${source.slice(start, index - Number(escaped))}"`
        ) as string;
      } catch {
        return JSON.parse(
          `${source.slice(start, source.lastIndexOf("\\"))}"`
        ) as string;
      }
    }
    return partial("Unterminated string literal");
  };

  const parseNumber = (): number => {
    const start = index;
    if (source[index] === "-") index++;
    while (source[index] && !",]}".includes(source[index])) index++;
    if (index === source.length && (ALLOW_NUMBER & ALLOW_ALL) === 0) {
      partial("Unterminated number literal");
    }
    try {
      return JSON.parse(source.slice(start, index)) as number;
    } catch (error) {
      if (source.slice(start, index) === "-") {
        partial("Incomplete negative number");
      }
      try {
        return JSON.parse(
          source.slice(start, source.lastIndexOf("e"))
        ) as number;
      } catch {
        return malformed(String(error));
      }
    }
  };

  let parseValue: () => JsonValue;

  const parseObject = (): { [key: string]: JsonValue } => {
    index++;
    skipWhitespace();
    const object: { [key: string]: JsonValue } = {};
    try {
      while (source[index] !== "}") {
        skipWhitespace();
        if (index >= source.length && (ALLOW_OBJECT & ALLOW_ALL) !== 0) {
          return object;
        }
        const key = parseString();
        skipWhitespace();
        index++;
        try {
          object[key] = parseValue();
        } catch (error) {
          if ((ALLOW_OBJECT & ALLOW_ALL) !== 0) return object;
          throw error;
        }
        skipWhitespace();
        if (source[index] === ",") index++;
      }
    } catch (error) {
      if ((ALLOW_OBJECT & ALLOW_ALL) !== 0) return object;
      partial(`Expected '}' at end of object: ${String(error)}`);
    }
    index++;
    return object;
  };

  const parseArray = (): JsonValue[] => {
    index++;
    const array: JsonValue[] = [];
    try {
      while (source[index] !== "]") {
        array.push(parseValue());
        skipWhitespace();
        if (source[index] === ",") index++;
      }
    } catch (error) {
      if ((ALLOW_ARRAY & ALLOW_ALL) !== 0) return array;
      partial(`Expected ']' at end of array: ${String(error)}`);
    }
    index++;
    return array;
  };

  const parseKeyword = (
    keyword: "null" | "true" | "false" | "Infinity" | "-Infinity" | "NaN",
    value: JsonValue,
    allowed: number
  ): { readonly value: JsonValue } | undefined => {
    const remaining = source.slice(index);
    if (remaining.startsWith(keyword)) {
      index += keyword.length;
      return { value };
    }
    if (
      (allowed & ALLOW_ALL) !== 0 &&
      remaining.length < keyword.length &&
      keyword.startsWith(remaining)
    ) {
      index += keyword.length;
      return { value };
    }
    return undefined;
  };

  parseValue = (): JsonValue => {
    skipWhitespace();
    if (index >= source.length) partial("Unexpected end of input");
    if (source[index] === '"') return parseString();
    if (source[index] === "{") return parseObject();
    if (source[index] === "[") return parseArray();

    const keyword =
      parseKeyword("null", null, ALLOW_NULL) ??
      parseKeyword("true", true, ALLOW_BOOLEAN) ??
      parseKeyword("false", false, ALLOW_BOOLEAN) ??
      parseKeyword("Infinity", Infinity, ALLOW_INFINITY) ??
      parseKeyword("-Infinity", -Infinity, ALLOW_NEGATIVE_INFINITY) ??
      parseKeyword("NaN", Number.NaN, ALLOW_NAN);
    return keyword === undefined ? parseNumber() : keyword.value;
  };

  return parseValue();
}
