const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_UNBIASED_RANDOM_BYTE = 256 - (256 % ALPHABET.length);

export function randomAlphanumeric(length = 12): string {
  let value = "";
  const bytes = new Uint8Array(length);
  while (value.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= MAX_UNBIASED_RANDOM_BYTE) continue;
      value += ALPHABET[byte % ALPHABET.length];
      if (value.length === length) break;
    }
  }
  return value;
}
