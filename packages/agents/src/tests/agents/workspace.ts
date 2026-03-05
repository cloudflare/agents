import {
  subscribe as dcSubscribe,
  unsubscribe as dcUnsubscribe
} from "node:diagnostics_channel";
import { Agent, callable } from "../../index.ts";
import {
  Workspace,
  BashSession,
  defineCommand,
  type FileInfo,
  type FileStat,
  type BashResult,
  type WorkspaceChangeEvent
} from "../../experimental/workspace.ts";

const greetCommand = defineCommand("greet", async (args) => ({
  stdout: `Hello, ${args[0] || "world"}!\n`,
  stderr: "",
  exitCode: 0
}));

const addCommand = defineCommand("add", async (args) => {
  const sum = args.reduce((acc, n) => acc + Number(n), 0);
  return { stdout: `${sum}\n`, stderr: "", exitCode: 0 };
});

export class TestWorkspaceAgent extends Agent<Record<string, unknown>> {
  workspace = new Workspace(this);
  wsWithCommands = new Workspace(this, {
    namespace: "cmds",
    commands: [greetCommand]
  });
  wsWithEnv = new Workspace(this, {
    namespace: "envws",
    env: { GREETING: "hi", LANG: "en" }
  });
  wsWithNetwork = new Workspace(this, {
    namespace: "netws",
    network: { allowedUrlPrefixes: ["https://example.com"] }
  });
  sessions = new Map<string, BashSession>();
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

  @callable()
  async stat(path: string): Promise<FileStat | null | { error: string }> {
    try {
      return this.workspace.stat(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async read(path: string): Promise<string | null | { error: string }> {
    try {
      return await this.workspace.readFile(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
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

  @callable()
  async del(path: string): Promise<boolean | { error: string }> {
    try {
      return await this.workspace.deleteFile(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async exists(path: string): Promise<boolean> {
    return this.workspace.fileExists(path);
  }

  @callable()
  async existsAny(path: string): Promise<boolean> {
    return this.workspace.exists(path);
  }

  @callable()
  async list(
    dir?: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> {
    return this.workspace.readDir(dir, opts);
  }

  @callable()
  async globCall(pattern: string): Promise<FileInfo[]> {
    return this.workspace.glob(pattern);
  }

  @callable()
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

  @callable()
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

  @callable()
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

  @callable()
  async readlinkCall(path: string): Promise<string | { error: string }> {
    try {
      return this.workspace.readlink(path);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async lstatCall(path: string): Promise<FileStat | null> {
    return this.workspace.lstat(path);
  }

  @callable()
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

  @callable()
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

  @callable()
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

  @callable()
  async bashCall(command: string): Promise<BashResult> {
    return await this.workspace.bash(command);
  }

  @callable()
  async bashWithCwd(command: string, cwd: string): Promise<BashResult> {
    return await this.workspace.bash(command, { cwd });
  }

  @callable()
  async bashWithPerCallCommand(command: string): Promise<BashResult> {
    return await this.workspace.bash(command, {
      commands: [addCommand]
    });
  }

  @callable()
  async bashWithWorkspaceCommand(command: string): Promise<BashResult> {
    return await this.wsWithCommands.bash(command);
  }

  @callable()
  async bashWithBothCommands(command: string): Promise<BashResult> {
    return await this.wsWithCommands.bash(command, {
      commands: [addCommand]
    });
  }

  @callable()
  async bashWithPerCallEnv(command: string): Promise<BashResult> {
    return await this.workspace.bash(command, {
      env: { NAME: "Alice", COUNT: "42" }
    });
  }

  @callable()
  async bashWithWorkspaceEnv(command: string): Promise<BashResult> {
    return await this.wsWithEnv.bash(command);
  }

  @callable()
  async bashWithBothEnv(command: string): Promise<BashResult> {
    return await this.wsWithEnv.bash(command, {
      env: { GREETING: "hello", EXTRA: "yes" }
    });
  }

  @callable()
  async bashWithNetwork(command: string): Promise<BashResult> {
    return await this.wsWithNetwork.bash(command);
  }

  @callable()
  async bashWithPerCallNetwork(command: string): Promise<BashResult> {
    return await this.workspace.bash(command, {
      network: { allowedUrlPrefixes: ["https://httpbin.org"] }
    });
  }

  @callable()
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

  @callable()
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

  @callable()
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

  @callable()
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

  @callable()
  async writeBytes(
    path: string,
    data: number[],
    mimeType?: string
  ): Promise<void> {
    const bytes = new Uint8Array(data);
    await this.workspace.writeFileBytes(path, bytes, mimeType);
  }

  @callable()
  async readBytes(path: string): Promise<number[] | null> {
    const bytes = await this.workspace.readFileBytes(path);
    if (bytes === null) return null;
    return Array.from(bytes);
  }

  @callable()
  async writeWithEvents(path: string, content: string): Promise<void> {
    await this.wsWithEvents.writeFile(path, content);
  }

  @callable()
  async deleteWithEvents(path: string): Promise<boolean> {
    return await this.wsWithEvents.deleteFile(path);
  }

  @callable()
  async mkdirWithEvents(
    path: string,
    opts?: { recursive?: boolean }
  ): Promise<void> {
    await Promise.resolve().then(() => this.wsWithEvents.mkdir(path, opts));
  }

  @callable()
  async rmWithEvents(
    path: string,
    opts?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.wsWithEvents.rm(path, opts);
  }

  @callable()
  async symlinkWithEvents(target: string, linkPath: string): Promise<void> {
    await Promise.resolve().then(() =>
      this.wsWithEvents.symlink(target, linkPath)
    );
  }

  @callable()
  async getChangeLog(): Promise<WorkspaceChangeEvent[]> {
    return this.changeLog;
  }

  @callable()
  async clearChangeLog(): Promise<void> {
    this.changeLog = [];
  }

  @callable()
  async createSession(
    name: string,
    opts?: { cwd?: string; env?: Record<string, string> }
  ): Promise<void> {
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists`);
    }
    this.sessions.set(name, this.workspace.createBashSession(opts));
  }

  @callable()
  async sessionExec(name: string, command: string): Promise<BashResult> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" not found`);
    return await session.exec(command);
  }

  @callable()
  async sessionGetCwd(name: string): Promise<string> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" not found`);
    return session.cwd;
  }

  @callable()
  async sessionGetEnv(name: string): Promise<Record<string, string>> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" not found`);
    return session.env;
  }

  @callable()
  async sessionIsClosed(name: string): Promise<boolean> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" not found`);
    return session.isClosed;
  }

  @callable()
  async sessionClose(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" not found`);
    session.close();
    this.sessions.delete(name);
  }

  @callable()
  async info(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    return this.workspace.getWorkspaceInfo();
  }

  @callable()
  async startObservability(): Promise<void> {
    this.observabilityLog = [];
    this._observabilityHandler = (message: unknown) => {
      this.observabilityLog.push(message as Record<string, unknown>);
    };
    dcSubscribe("agents:workspace", this._observabilityHandler);
  }

  @callable()
  async stopObservability(): Promise<void> {
    if (this._observabilityHandler) {
      dcUnsubscribe("agents:workspace", this._observabilityHandler);
      this._observabilityHandler = null;
    }
  }

  @callable()
  async getObservabilityLog(): Promise<Record<string, unknown>[]> {
    return this.observabilityLog;
  }

  @callable()
  async clearObservabilityLog(): Promise<void> {
    this.observabilityLog = [];
  }
}
