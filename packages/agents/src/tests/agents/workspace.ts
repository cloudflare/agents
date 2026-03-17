import {
  subscribe as dcSubscribe,
  unsubscribe as dcUnsubscribe
} from "node:diagnostics_channel";
import { Agent } from "../../index.ts";
import {
  Workspace,
  type FileInfo,
  type FileStat,
  type WorkspaceChangeEvent
} from "../../experimental/workspace.ts";

export class TestWorkspaceAgent extends Agent<Record<string, unknown>> {
  workspace = new Workspace(this);
  changeLog: WorkspaceChangeEvent[] = [];
  observabilityLog: Record<string, unknown>[] = [];
  private _observabilityHandler:
    | ((message: unknown, name: string | symbol) => void)
    | null = null;
  wsWithEvents = new Workspace(this, {
    namespace: "evts",
    onChange: (event) => {
      this.changeLog.push(event);
    }
  });

  // ── @callable() methods for test access ──────────────────────────

  async stat(path: string): Promise<FileStat | null | { error: string }> {
    try {
      return this.workspace.stat(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async read(path: string): Promise<string | null | { error: string }> {
    try {
      return await this.workspace.readFile(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async write(
    path: string,
    content: string,
    mimeType?: string
  ): Promise<void | { error: string }> {
    try {
      await this.workspace.writeFile(path, content, mimeType);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async del(path: string): Promise<boolean | { error: string }> {
    try {
      return await this.workspace.deleteFile(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.workspace.fileExists(path);
  }

  async existsAny(path: string): Promise<boolean> {
    return this.workspace.exists(path);
  }

  async list(
    dir?: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> {
    return this.workspace.readDir(dir, opts);
  }

  async globCall(pattern: string): Promise<FileInfo[]> {
    return this.workspace.glob(pattern);
  }

  async mkdirCall(
    path: string,
    opts?: { recursive?: boolean }
  ): Promise<void | { error: string }> {
    try {
      this.workspace.mkdir(path, opts);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async rmCall(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void | { error: string }> {
    try {
      await this.workspace.rm(path, opts);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async symlinkCall(
    target: string,
    linkPath: string
  ): Promise<void | { error: string }> {
    try {
      this.workspace.symlink(target, linkPath);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async readlinkCall(path: string): Promise<string | { error: string }> {
    try {
      return this.workspace.readlink(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async lstatCall(path: string): Promise<FileStat | null> {
    return this.workspace.lstat(path);
  }

  async readStream(path: string): Promise<string | null> {
    const stream = await this.workspace.readFileStream(path);
    if (!stream) return null;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let totalSize = 0;
    for (const c of chunks) totalSize += c.byteLength;
    const buf = new Uint8Array(totalSize);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder().decode(buf);
  }

  async writeStream(
    path: string,
    content: string
  ): Promise<void | { error: string }> {
    try {
      const bytes = new TextEncoder().encode(content);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      });
      await this.workspace.writeFileStream(path, stream);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async writeStreamBytes(
    path: string,
    data: number[]
  ): Promise<void | { error: string }> {
    try {
      const bytes = new Uint8Array(data);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      });
      await this.workspace.writeFileStream(path, stream);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async diffCall(
    pathA: string,
    pathB: string
  ): Promise<string | { error: string }> {
    try {
      return await this.workspace.diff(pathA, pathB);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async diffContentCall(
    path: string,
    newContent: string
  ): Promise<string | { error: string }> {
    try {
      return await this.workspace.diffContent(path, newContent);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async cpCall(
    src: string,
    dest: string,
    opts?: { recursive?: boolean }
  ): Promise<void | { error: string }> {
    try {
      await this.workspace.cp(src, dest, opts);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async mvCall(
    src: string,
    dest: string,
    opts?: { recursive?: boolean }
  ): Promise<void | { error: string }> {
    try {
      await this.workspace.mv(src, dest, opts);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async writeBytes(
    path: string,
    data: number[],
    mimeType?: string
  ): Promise<void> {
    const bytes = new Uint8Array(data);
    await this.workspace.writeFileBytes(path, bytes, mimeType);
  }

  async readBytes(path: string): Promise<number[] | null> {
    const bytes = await this.workspace.readFileBytes(path);
    if (bytes === null) return null;
    return Array.from(bytes);
  }

  async writeWithEvents(path: string, content: string): Promise<void> {
    await this.wsWithEvents.writeFile(path, content);
  }

  async deleteWithEvents(path: string): Promise<boolean> {
    return await this.wsWithEvents.deleteFile(path);
  }

  async mkdirWithEvents(
    path: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    await Promise.resolve().then(() => this.wsWithEvents.mkdir(path, opts));
  }

  async rmWithEvents(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.wsWithEvents.rm(path, opts);
  }

  async symlinkWithEvents(target: string, linkPath: string): Promise<void> {
    await Promise.resolve().then(() =>
      this.wsWithEvents.symlink(target, linkPath)
    );
  }

  async getChangeLog(): Promise<WorkspaceChangeEvent[]> {
    return this.changeLog;
  }

  async clearChangeLog(): Promise<void> {
    this.changeLog = [];
  }

  async info(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    return this.workspace.getWorkspaceInfo();
  }

  async startObservability(): Promise<void> {
    this.observabilityLog = [];
    this._observabilityHandler = (message: unknown) => {
      this.observabilityLog.push(message as Record<string, unknown>);
    };
    dcSubscribe("agents:workspace", this._observabilityHandler);
  }

  async stopObservability(): Promise<void> {
    if (this._observabilityHandler) {
      dcUnsubscribe("agents:workspace", this._observabilityHandler);
      this._observabilityHandler = null;
    }
  }

  async getObservabilityLog(): Promise<Record<string, unknown>[]> {
    return this.observabilityLog;
  }

  async clearObservabilityLog(): Promise<void> {
    this.observabilityLog = [];
  }
}
