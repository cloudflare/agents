import type {
  BufferEncoding,
  ReadFileOptions,
  WriteFileOptions
} from "./interface";

export type FileContent = string | Uint8Array;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBuffer(
  content: FileContent,
  encoding?: BufferEncoding
): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (encoding === "base64") {
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  }
  if (encoding === "hex") {
    const bytes = new Uint8Array(content.length / 2);
    for (let i = 0; i < content.length; i += 2) {
      bytes[i / 2] = parseInt(content.slice(i, i + 2), 16);
    }
    return bytes;
  }
  if (encoding === "binary" || encoding === "latin1") {
    const chunkSize = 65536;
    if (content.length <= chunkSize) {
      return Uint8Array.from(content, (c) => c.charCodeAt(0));
    }
    const result = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      result[i] = content.charCodeAt(i);
    }
    return result;
  }
  return textEncoder.encode(content);
}

export function fromBuffer(
  buffer: Uint8Array,
  encoding?: BufferEncoding | null
): string {
  if (encoding === "base64") {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(buffer).toString("base64");
    }
    const chunkSize = 65536;
    let binary = "";
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  if (encoding === "hex") {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (encoding === "binary" || encoding === "latin1") {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(buffer).toString(encoding);
    }
    const chunkSize = 65536;
    if (buffer.length <= chunkSize) {
      return String.fromCharCode(...buffer);
    }
    let result = "";
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.subarray(i, i + chunkSize);
      result += String.fromCharCode(...chunk);
    }
    return result;
  }
  return textDecoder.decode(buffer);
}

export function getEncoding(
  options?: ReadFileOptions | WriteFileOptions | BufferEncoding | string | null
): BufferEncoding | undefined {
  if (options === null || options === undefined) {
    return undefined;
  }
  if (typeof options === "string") {
    return options as BufferEncoding;
  }
  return options.encoding ?? undefined;
}
