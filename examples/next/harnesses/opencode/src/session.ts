const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const UNBIASED_BYTE_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

type RandomFill = (target: Uint8Array<ArrayBuffer>) => void;

export function createSessionName(
  fill: RandomFill = (target) => {
    crypto.getRandomValues(target);
  }
): string {
  let name = "";
  while (name.length < 12) {
    const bytes = new Uint8Array(12 - name.length);
    fill(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      name += ALPHABET[byte % ALPHABET.length];
      if (name.length === 12) break;
    }
  }
  return name;
}
