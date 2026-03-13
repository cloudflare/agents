/**
 * Shared checksum utilities for md5sum, sha1sum, sha256sum
 * Uses WebCrypto API for SHA algorithms, pure JS for MD5
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

export type HashAlgorithm = "md5" | "sha1" | "sha256";

// Map prevents prototype pollution
const WEBCRYPTO_ALGORITHMS = new Map<string, string>([
  ["sha1", "SHA-1"],
  ["sha256", "SHA-256"]
]);

// Pure JS MD5 implementation (WebCrypto doesn't support MD5)
function md5(bytes: Uint8Array): string {
  function rotateLeft(x: number, n: number): number {
    return (x << n) | (x >>> (32 - n));
  }

  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ]);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21
  ];

  // Padding
  const bitLen = bytes.length * 8;
  const paddingLen = (bytes.length % 64 < 56 ? 56 : 120) - (bytes.length % 64);
  const padded = new Uint8Array(bytes.length + paddingLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(i + j * 4, true);
    }

    let A = a0,
      B = b0,
      C = c0,
      D = d0;

    for (let j = 0; j < 64; j++) {
      let F: number, g: number;
      if (j < 16) {
        F = (B & C) | (~B & D);
        g = j;
      } else if (j < 32) {
        F = (D & B) | (~D & C);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        F = B ^ C ^ D;
        g = (3 * j + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * j) % 16;
      }
      F = (F + A + K[j] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotateLeft(F, S[j])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const result = new Uint8Array(16);
  new DataView(result.buffer).setUint32(0, a0, true);
  new DataView(result.buffer).setUint32(4, b0, true);
  new DataView(result.buffer).setUint32(8, c0, true);
  new DataView(result.buffer).setUint32(12, d0, true);

  return Array.from(result)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeHash(
  algorithm: HashAlgorithm,
  data: Uint8Array
): Promise<string> {
  if (algorithm === "md5") {
    return md5(data);
  }

  const algoName = WEBCRYPTO_ALGORITHMS.get(algorithm);
  if (!algoName) {
    throw new Error(`Unknown algorithm: ${algorithm}`);
  }
  const hashBuffer = await globalThis.crypto.subtle.digest(
    algoName,
    new Uint8Array(data).buffer as ArrayBuffer
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createChecksumCommand(
  name: string,
  algorithm: HashAlgorithm,
  summary: string
): Command {
  const help = {
    name,
    summary,
    usage: `${name} [OPTION]... [FILE]...`,
    options: [
      "-c, --check    read checksums from FILEs and check them",
      "    --help     display this help and exit"
    ]
  };

  return {
    name,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (hasHelpFlag(args)) return showHelp(help);

      let check = false;
      const files: string[] = [];

      for (const arg of args) {
        if (arg === "-c" || arg === "--check") check = true;
        else if (
          arg === "-b" ||
          arg === "-t" ||
          arg === "--binary" ||
          arg === "--text"
        ) {
          /* ignored */
        } else if (arg.startsWith("-") && arg !== "-")
          return unknownOption(name, arg);
        else files.push(arg);
      }

      if (files.length === 0) files.push("-");

      // Helper to read file as binary
      const readBinary = async (file: string): Promise<Uint8Array | null> => {
        if (file === "-") {
          // Convert binary string directly to bytes without UTF-8 re-encoding
          return Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
        }
        try {
          return await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, file));
        } catch {
          return null;
        }
      };

      if (check) {
        let failed = 0;
        let output = "";

        for (const file of files) {
          // For check mode, we read the checksum file as text
          const content =
            file === "-"
              ? ctx.stdin
              : await ctx.fs
                  .readFile(ctx.fs.resolvePath(ctx.cwd, file))
                  .catch(() => null);
          if (content === null)
            return {
              stdout: "",
              stderr: `${name}: ${file}: No such file or directory\n`,
              exitCode: 1
            };

          for (const line of content.split("\n")) {
            const match = line.match(/^([a-fA-F0-9]+)\s+[* ]?(.+)$/);
            if (!match) continue;

            const [, expectedHash, targetFile] = match;
            const fileContent = await readBinary(targetFile);
            if (fileContent === null) {
              output += `${targetFile}: FAILED open or read\n`;
              failed++;
              continue;
            }
            const ok =
              (await computeHash(algorithm, fileContent)) ===
              expectedHash.toLowerCase();
            output += `${targetFile}: ${ok ? "OK" : "FAILED"}\n`;
            if (!ok) failed++;
          }
        }

        if (failed > 0)
          output += `${name}: WARNING: ${failed} computed checksum${failed > 1 ? "s" : ""} did NOT match\n`;
        return { stdout: output, stderr: "", exitCode: failed > 0 ? 1 : 0 };
      }

      let output = "";
      let exitCode = 0;

      for (const file of files) {
        const content = await readBinary(file);
        if (content === null) {
          output += `${name}: ${file}: No such file or directory\n`;
          exitCode = 1;
          continue;
        }
        output += `${await computeHash(algorithm, content)}  ${file}\n`;
      }

      return { stdout: output, stderr: "", exitCode };
    }
  };
}
