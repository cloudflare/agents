// This module is embedded inside generated Dynamic Workers, so it operates
// only through intrinsics captured before guest code can change them.

const runUtf8MathCeil = Math.ceil;
const runUtf8ReflectApply = Reflect.apply;
const runUtf8ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const runUtf8ReflectGetPrototypeOf = Reflect.getPrototypeOf;
const runUtf8StringCharCodeAt = String.prototype.charCodeAt;
const runUtf8StringSlice = String.prototype.slice;
const runUtf8TextEncoder = new TextEncoder();
const runUtf8TextEncoderEncode = TextEncoder.prototype.encode;

function getRunUtf8ByteLengthGetter(): (this: object) => number {
  const prototype = runUtf8ReflectGetPrototypeOf(Uint8Array.prototype);
  const getter =
    prototype === null
      ? undefined
      : runUtf8ReflectGetOwnPropertyDescriptor(prototype, "byteLength")?.get;
  if (getter === undefined) {
    throw new Error("Run UTF-8 byte measurement is unavailable.");
  }
  return getter;
}

const runUtf8ByteLengthGetter = getRunUtf8ByteLengthGetter();

function getRunUtf8ByteLength(value: string): number {
  const encoded = runUtf8ReflectApply(
    runUtf8TextEncoderEncode,
    runUtf8TextEncoder,
    [value]
  );
  return runUtf8ReflectApply(runUtf8ByteLengthGetter, encoded, []);
}

/**
 * Truncate a string to at most `maximumBytes` UTF-8 bytes.
 *
 * Truncation preserves valid UTF-8, drops a split surrogate pair, and appends
 * a visible `…` suffix within the byte budget.
 */
function truncateRunUtf8(value: string, maximumBytes: number): string {
  if (getRunUtf8ByteLength(value) <= maximumBytes) return value;

  const suffix = "…";
  const contentBytes = maximumBytes - getRunUtf8ByteLength(suffix);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = runUtf8MathCeil((low + high) / 2);
    const candidate = runUtf8ReflectApply(runUtf8StringSlice, value, [
      0,
      middle
    ]);
    if (getRunUtf8ByteLength(candidate) <= contentBytes) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 &&
    runUtf8ReflectApply(runUtf8StringCharCodeAt, value, [low - 1]) >= 0xd800 &&
    runUtf8ReflectApply(runUtf8StringCharCodeAt, value, [low - 1]) <= 0xdbff
  ) {
    low--;
  }
  return `${runUtf8ReflectApply(runUtf8StringSlice, value, [0, low])}${suffix}`;
}

export { truncateRunUtf8 };
