import type { BackendHandle, WorkspaceBackend } from "@cloudflare/workspace";
import type { FileStat, FileStore } from "./tools/fs/index";

/**
 * Preserve @cloudflare/workspace's container transport while disabling its
 * automatic DO-VFS ↔ container-VFS push/pull bracket. The container's
 * /workspace is authoritative.
 */
export class ContainerLocalBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type = "container-local";

  constructor(private readonly backend: WorkspaceBackend) {
    this.id = backend.id;
  }

  async connect(): Promise<BackendHandle> {
    const handle = await this.backend.connect();
    handle.sync = "none";
    return handle;
  }
}

interface ContainerShell {
  exec(
    command: string,
    options: { encoding: "utf8"; backend: string }
  ): Promise<{
    result(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }>;
}

const READ_CHUNK_BYTES = 64 * 1024;
const WRITE_CHUNK_BYTES = 48 * 1024;

/** FileStore backed entirely by the container's local /workspace filesystem. */
export class ContainerFileStore implements FileStore {
  constructor(private readonly shell: ContainerShell) {}

  async stat(path: string): Promise<FileStat | null> {
    const result = await this.run(
      `if [ -f ${quote(path)} ]; then stat -c '%s\t%Y\t%f' -- ${quote(path)}; else exit 44; fi`,
      [0, 44]
    );
    if (result.exitCode === 44) return null;

    const [size, mtimeSeconds, modeHex] = result.stdout.trim().split("\t");
    if (!size || !mtimeSeconds || !modeHex) {
      throw new Error(`Unable to parse stat output for ${path}`);
    }
    return {
      size: Number(size),
      mtime: Number(mtimeSeconds) * 1000,
      mode: Number.parseInt(modeHex, 16)
    };
  }

  async readAll(path: string): Promise<Uint8Array | null> {
    const stat = await this.stat(path);
    if (!stat) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.readChunks(path, 0, stat.size)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    return concat(chunks, total);
  }

  async *readChunks(
    path: string,
    byteOffset = 0,
    byteLength?: number
  ): AsyncIterable<Uint8Array> {
    const stat = await this.stat(path);
    if (!stat) throw enoent(path);

    const end = Math.min(
      stat.size,
      byteLength === undefined ? stat.size : byteOffset + byteLength
    );
    for (let offset = byteOffset; offset < end; offset += READ_CHUNK_BYTES) {
      const count = Math.min(READ_CHUNK_BYTES, end - offset);
      const result = await this.run(
        `dd if=${quote(path)} iflag=skip_bytes,count_bytes skip=${offset} count=${count} status=none | base64 -w0`
      );
      const bytes = decodeBase64(result.stdout.trim());
      if (bytes.byteLength === 0) break;
      yield bytes;
    }
  }

  async write(
    path: string,
    content: Uint8Array,
    opts?: { mode?: number }
  ): Promise<void> {
    const parent = parentDir(path);
    const temp = `/workspace/temp/.agent-write-${crypto.randomUUID()}`;
    let committed = false;
    try {
      await this.run(
        `set -e; mkdir -p ${quote(parent)} /workspace/temp; : > ${quote(temp)}`
      );
      for (
        let offset = 0;
        offset < content.byteLength;
        offset += WRITE_CHUNK_BYTES
      ) {
        const encoded = encodeBase64(
          content.subarray(offset, offset + WRITE_CHUNK_BYTES)
        );
        await this.run(
          `printf %s ${quote(encoded)} | base64 -d >> ${quote(temp)}`
        );
      }
      const mode = (opts?.mode ?? 0o644) & 0o7777;
      await this.run(
        `set -e; chmod ${mode.toString(8)} ${quote(temp)}; mv -f ${quote(temp)} ${quote(path)}`
      );
      committed = true;
    } finally {
      if (!committed) {
        await this.run(`rm -f ${quote(temp)}`, [0]).catch(() => {});
      }
    }
  }

  private async run(command: string, allowedExitCodes = [0]) {
    const handle = await this.shell.exec(command, {
      encoding: "utf8",
      backend: "container"
    });
    const result = await handle.result();
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new Error(
        `Container filesystem command failed (${result.exitCode}): ${result.stderr || result.stdout}`
      );
    }
    return result;
  }
}

export function repoDirectory(repo: string | undefined): string {
  const name = repo?.split("/").filter(Boolean).at(-1) ?? "repo";
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  return `/workspace/${safe}`;
}

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/workspace" : path.slice(0, index);
}

function enoent(path: string): Error & { code: string } {
  return Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
    code: "ENOENT"
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
