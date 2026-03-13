/**
 * Tar archive utilities — pure JS implementation
 *
 * Provides helpers for creating and extracting tar archives
 * with gzip compression via Web Standard CompressionStream.
 * bzip2, xz, and zstd are not supported (require native addons).
 */

const BLOCK = 512;
const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const USTAR_NAME_LIMIT = 99;
const USTAR_LINKNAME_LIMIT = 99;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Public types ────────────────────────────────────────────────────

export interface TarCreateEntry {
  name: string;
  content?: Uint8Array | string;
  mode?: number;
  mtime?: Date;
  isDirectory?: boolean;
  isSymlink?: boolean;
  linkTarget?: string;
  uid?: number;
  gid?: number;
}

export interface ParsedEntry {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: Date;
  type: "file" | "directory" | "symlink" | "hardlink" | "other";
  linkTarget?: string;
  content: Uint8Array;
}

// ── Tar header helpers ──────────────────────────────────────────────

function writeOctal(
  buf: Uint8Array,
  offset: number,
  len: number,
  val: number
): void {
  const s = val.toString(8).padStart(len - 1, "0");
  for (let i = 0; i < len - 1; i++) buf[offset + i] = s.charCodeAt(i);
  buf[offset + len - 1] = 0;
}

function writeString(
  buf: Uint8Array,
  offset: number,
  len: number,
  val: string
): void {
  const bytes = encoder.encode(val);
  buf.set(bytes.subarray(0, len), offset);
}

function readOctal(buf: Uint8Array, offset: number, len: number): number {
  let s = "";
  for (let i = 0; i < len; i++) {
    const b = buf[offset + i];
    if (b === 0 || b === 0x20) break;
    s += String.fromCharCode(b);
  }
  return s ? parseInt(s, 8) : 0;
}

function readString(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  const limit = offset + len;
  while (end < limit && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(offset, end));
}

function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // Checksum field (offset 148, length 8) treated as spaces
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function isAllZeros(buf: Uint8Array, offset: number, len: number): boolean {
  for (let i = 0; i < len; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

// ── PAX extended header helpers ──────────────────────────────────────

/**
 * Build a PAX extended header record.  Each record is:
 *   "<len> <key>=<value>\n"
 * where <len> includes itself, the space, key=value, and the newline.
 */
function buildPaxRecord(key: string, value: string): string {
  // Start with a guess for the length prefix
  const base = ` ${key}=${value}\n`;
  let len = base.length + 1; // +1 for at least one digit
  // The length field includes its own digits, so iterate until stable
  while (len.toString().length + base.length > len) {
    len = len.toString().length + base.length;
  }
  return `${len}${base}`;
}

/**
 * Create a PAX extended header block (typeflag 'x') containing
 * the given key=value pairs.
 */
function packPaxHeader(attrs: Record<string, string>): Uint8Array {
  let body = "";
  for (const [key, value] of Object.entries(attrs)) {
    body += buildPaxRecord(key, value);
  }
  const bodyBytes = encoder.encode(body);
  const bodySize = bodyBytes.length;
  const paddedSize = Math.ceil(bodySize / BLOCK) * BLOCK;

  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, "PaxHeader"); // placeholder name
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bodySize);
  writeOctal(header, 136, 12, 0);
  header[156] = 0x78; // 'x' = PAX extended header
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");

  const cksum = computeChecksum(header);
  writeOctal(header, 148, 7, cksum);
  header[155] = 0x20;

  const result = new Uint8Array(BLOCK + paddedSize);
  result.set(header);
  result.set(bodyBytes, BLOCK);
  return result;
}

/**
 * Parse PAX extended header body into key=value pairs.
 */
function parsePaxBody(data: Uint8Array): Record<string, string> {
  const text = decoder.decode(data);
  const attrs: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const spaceIdx = text.indexOf(" ", offset);
    if (spaceIdx === -1) break;
    const len = parseInt(text.slice(offset, spaceIdx), 10);
    if (isNaN(len) || len <= 0) break;
    const record = text.slice(offset, offset + len);
    const eqIdx = record.indexOf("=");
    if (eqIdx !== -1) {
      const key = record.slice(spaceIdx - offset + 1, eqIdx);
      // value ends before the trailing newline
      const value = record.slice(eqIdx + 1, record.length - 1);
      attrs[key] = value;
    }
    offset += len;
  }
  return attrs;
}

// ── Pack ────────────────────────────────────────────────────────────

function packEntry(entry: TarCreateEntry): Uint8Array {
  let name = entry.name;
  if (entry.isDirectory && !name.endsWith("/")) name += "/";

  let body: Uint8Array | undefined;
  if (entry.content !== undefined) {
    body =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : entry.content;
  }
  const size = entry.isDirectory || entry.isSymlink ? 0 : (body?.length ?? 0);

  // Check if we need PAX extended headers for long names
  const needsPax =
    encoder.encode(name).length > USTAR_NAME_LIMIT ||
    (entry.linkTarget &&
      encoder.encode(entry.linkTarget).length > USTAR_LINKNAME_LIMIT);

  const parts: Uint8Array[] = [];

  if (needsPax) {
    const paxAttrs: Record<string, string> = {};
    if (encoder.encode(name).length > USTAR_NAME_LIMIT) {
      paxAttrs.path = name;
    }
    if (
      entry.linkTarget &&
      encoder.encode(entry.linkTarget).length > USTAR_LINKNAME_LIMIT
    ) {
      paxAttrs.linkpath = entry.linkTarget;
    }
    parts.push(packPaxHeader(paxAttrs));
  }

  const header = new Uint8Array(BLOCK);

  // USTAR header layout — truncate name if PAX provides full path
  writeString(header, 0, 100, name.slice(0, USTAR_NAME_LIMIT)); // name
  writeOctal(header, 100, 8, entry.mode ?? (entry.isDirectory ? 0o755 : 0o644)); // mode
  writeOctal(header, 108, 8, entry.uid ?? 0); // uid
  writeOctal(header, 116, 8, entry.gid ?? 0); // gid
  writeOctal(header, 124, 12, size); // size
  writeOctal(
    header,
    136,
    12,
    Math.floor((entry.mtime ?? new Date()).getTime() / 1000)
  ); // mtime
  // typeflag
  if (entry.isDirectory)
    header[156] = 53; // '5'
  else if (entry.isSymlink)
    header[156] = 50; // '2'
  else header[156] = 48; // '0'
  const linkTarget = entry.linkTarget ?? "";
  writeString(header, 157, 100, linkTarget.slice(0, USTAR_LINKNAME_LIMIT)); // linkname
  writeString(header, 257, 6, "ustar"); // magic
  writeString(header, 263, 2, "00"); // version
  writeString(header, 265, 32, "user"); // uname
  writeString(header, 297, 32, "user"); // gname

  // Compute and write checksum
  const cksum = computeChecksum(header);
  writeOctal(header, 148, 7, cksum);
  header[155] = 0x20; // trailing space

  // Pad body to block boundary
  const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
  const entryBlock = new Uint8Array(BLOCK + paddedSize);
  entryBlock.set(header);
  if (body && body.length > 0) entryBlock.set(body, BLOCK);
  parts.push(entryBlock);

  // Merge parts
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}

export async function createArchive(
  entries: TarCreateEntry[]
): Promise<Uint8Array> {
  const parts = entries.map(packEntry);
  // Two zero blocks to mark end of archive
  parts.push(new Uint8Array(BLOCK * 2));
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── Unpack ──────────────────────────────────────────────────────────

export async function parseArchive(
  data: Uint8Array
): Promise<{ entries: ParsedEntry[]; error?: string }> {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  if (data.length < BLOCK || data.length % BLOCK !== 0) {
    return { entries: [], error: "Invalid tar archive format" };
  }

  const entries: ParsedEntry[] = [];
  let pos = 0;

  while (pos + BLOCK <= data.length) {
    if (isAllZeros(data, pos, BLOCK)) break;
    if (entries.length >= MAX_ENTRIES) {
      return { entries, error: `Too many entries (max ${MAX_ENTRIES})` };
    }

    const typeFlag = data[pos + 156];

    // Handle PAX extended headers (typeflag 'x' or 'X')
    if (typeFlag === 0x78 || typeFlag === 0x58) {
      const paxSize = readOctal(data, pos + 124, 12);
      pos += BLOCK;
      const paxBody = data.slice(pos, pos + paxSize);
      const paxAttrs = parsePaxBody(paxBody);
      const paxPaddedSize = Math.ceil(paxSize / BLOCK) * BLOCK;
      pos += paxPaddedSize;

      // The next entry is the actual file — parse it normally
      // then override name/linkname from PAX attributes
      if (pos + BLOCK > data.length || isAllZeros(data, pos, BLOCK)) continue;

      const name = paxAttrs.path ?? readString(data, pos, 100);
      const mode = readOctal(data, pos + 100, 8);
      const uid = readOctal(data, pos + 108, 8);
      const gid = readOctal(data, pos + 116, 8);
      const size = readOctal(data, pos + 124, 12);
      const mtime = new Date(readOctal(data, pos + 136, 12) * 1000);
      const nextTypeFlag = data[pos + 156];
      const linkname = paxAttrs.linkpath ?? readString(data, pos + 157, 100);

      let type: ParsedEntry["type"] = "file";
      switch (nextTypeFlag) {
        case 53:
          type = "directory";
          break;
        case 50:
          type = "symlink";
          break;
        case 49:
          type = "hardlink";
          break;
        case 48:
        case 0:
          type = "file";
          break;
        default:
          type = "other";
      }

      pos += BLOCK;
      const content =
        type === "file" && size > 0
          ? data.slice(pos, pos + size)
          : new Uint8Array(0);
      const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
      pos += paddedSize;

      entries.push({
        name,
        mode,
        uid,
        gid,
        size,
        mtime,
        type,
        linkTarget: linkname || undefined,
        content
      });
      continue;
    }

    const name = readString(data, pos, 100);
    const mode = readOctal(data, pos + 100, 8);
    const uid = readOctal(data, pos + 108, 8);
    const gid = readOctal(data, pos + 116, 8);
    const size = readOctal(data, pos + 124, 12);
    const mtime = new Date(readOctal(data, pos + 136, 12) * 1000);
    const linkname = readString(data, pos + 157, 100);

    let type: ParsedEntry["type"] = "file";
    switch (typeFlag) {
      case 53: // '5'
        type = "directory";
        break;
      case 50: // '2'
        type = "symlink";
        break;
      case 49: // '1'
        type = "hardlink";
        break;
      case 48: // '0'
      case 0: // legacy null byte = regular file
        type = "file";
        break;
      default:
        type = "other";
    }

    pos += BLOCK;
    const content =
      type === "file" && size > 0
        ? data.slice(pos, pos + size)
        : new Uint8Array(0);
    const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
    pos += paddedSize;

    entries.push({
      name,
      mode,
      uid,
      gid,
      size,
      mtime,
      type,
      linkTarget: linkname || undefined,
      content
    });
  }

  return { entries };
}

// ── Gzip (Web Standard CompressionStream) ───────────────────────────

async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
  maxSize: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxSize) {
      await reader.cancel();
      throw new Error(`Output exceeds max size (${maxSize} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function bytesToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

export async function createCompressedArchive(
  entries: TarCreateEntry[]
): Promise<Uint8Array> {
  const tar = await createArchive(entries);
  const compressed = bytesToStream(tar).pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >
  );
  return streamToBytes(compressed, MAX_ARCHIVE_SIZE);
}

export async function parseCompressedArchive(
  data: Uint8Array
): Promise<{ entries: ParsedEntry[]; error?: string }> {
  if (data.length > MAX_ARCHIVE_SIZE) {
    return {
      entries: [],
      error: `Archive too large (max ${MAX_ARCHIVE_SIZE} bytes)`
    };
  }
  try {
    const decompressed = bytesToStream(data).pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >
    );
    const tar = await streamToBytes(decompressed, MAX_ARCHIVE_SIZE);
    return parseArchive(tar);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { entries: [], error: `Decompression failed: ${msg}` };
  }
}

// ── Magic byte detection ────────────────────────────────────────────

export function isGzipCompressed(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export function isBzip2Compressed(data: Uint8Array): boolean {
  return (
    data.length >= 3 && data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68
  );
}

export function isXzCompressed(data: Uint8Array): boolean {
  return (
    data.length >= 6 &&
    data[0] === 0xfd &&
    data[1] === 0x37 &&
    data[2] === 0x7a &&
    data[3] === 0x58 &&
    data[4] === 0x5a &&
    data[5] === 0x00
  );
}

export function isZstdCompressed(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x28 &&
    data[1] === 0xb5 &&
    data[2] === 0x2f &&
    data[3] === 0xfd
  );
}

// ── Unsupported compression formats ─────────────────────────────────
// bzip2, xz, and zstd require native addons and cannot run on Workers.

const UNSUPPORTED = (fmt: string) =>
  `${fmt} compression is not supported in this environment (requires native addons)`;

export async function createBzip2CompressedArchive(
  _entries: TarCreateEntry[]
): Promise<Uint8Array> {
  throw new Error(UNSUPPORTED("bzip2"));
}

export async function createXzCompressedArchive(
  _entries: TarCreateEntry[]
): Promise<Uint8Array> {
  throw new Error(UNSUPPORTED("xz"));
}

export async function createZstdCompressedArchive(
  _entries: TarCreateEntry[]
): Promise<Uint8Array> {
  throw new Error(UNSUPPORTED("zstd"));
}

export async function parseBzip2CompressedArchive(
  _data: Uint8Array
): Promise<{ entries: ParsedEntry[]; error?: string }> {
  return { entries: [], error: UNSUPPORTED("bzip2") };
}

export async function parseXzCompressedArchive(
  _data: Uint8Array
): Promise<{ entries: ParsedEntry[]; error?: string }> {
  return { entries: [], error: UNSUPPORTED("xz") };
}

export async function parseZstdCompressedArchive(
  _data: Uint8Array
): Promise<{ entries: ParsedEntry[]; error?: string }> {
  return { entries: [], error: UNSUPPORTED("zstd") };
}
