import { parseSSEStream, type FileWatchSSEEvent } from "@cloudflare/sandbox";
import type { SandboxWorkspace } from "./sandbox-workspace";
import type { ServerMessage } from "./types";

/**
 * Manages a filesystem watcher on /workspace inside the sandbox.
 * Broadcasts file-change events via the provided `broadcast` callback.
 */
export class FileWatcher {
  private controller: AbortController | null = null;
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start watching /workspace for filesystem changes. Calls `broadcast`
   * with a JSON-serialized ServerMessage for each change event.
   * Runs as a background async loop — call `stop()` to tear down.
   */
  start(sw: SandboxWorkspace, broadcast: (msg: string) => void): void {
    if (this.running) return;
    this.running = true;

    const controller = new AbortController();
    this.controller = controller;

    (async () => {
      try {
        const stream = await sw.watch("/workspace");

        for await (const event of parseSSEStream<FileWatchSSEEvent>(
          stream,
          controller.signal
        )) {
          if (event.type === "event") {
            const msg: ServerMessage = {
              type: "file-change",
              eventType: event.eventType,
              path: event.path,
              isDirectory: event.isDirectory
            };
            broadcast(JSON.stringify(msg));
          } else if (event.type === "error" || event.type === "stopped") {
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("[file-watcher] Error:", err);
        }
      } finally {
        this.running = false;
        this.controller = null;
      }
    })();
  }

  /** Stop the watcher. Safe to call if not running. */
  stop(): void {
    this.controller?.abort();
    this.running = false;
    this.controller = null;
  }
}
