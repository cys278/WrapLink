import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateCode(length = 8): string {
  let result = "";
  while (result.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      // Rejection sampling avoids modulo bias.
      if (byte >= 248) continue;
      result += ALPHABET[byte % ALPHABET.length];
      if (result.length === length) break;
    }
  }
  return result;
}
