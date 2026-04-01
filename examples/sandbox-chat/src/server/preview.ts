import { getSandbox } from "@cloudflare/sandbox";
import type { ServerMessage } from "./types";

/**
 * Manages preview URL state for exposed sandbox ports.
 *
 * Exposed ports are persisted by the sandbox container DO itself, so
 * this class only caches state in-memory for the current DO lifetime.
 * After hibernation, `restore()` re-fetches the active ports from the
 * sandbox rather than duplicating state in agent DO storage.
 */
export class PreviewManager {
  private _url: string | null = null;
  private _port: number | null = null;
  private _hostname: string | null = null;
  private _restored = false;

  /**
   * Restore preview state from the sandbox after DO hibernation.
   * Queries the sandbox for currently exposed ports rather than
   * duplicating state in agent DO storage.
   *
   * Requires `captureHostname()` to have been called first (it is —
   * `onConnect` calls it before `ensureWorkspace`).
   * Safe to call multiple times — only queries on the first call.
   */
  async restore(
    sandboxBinding: DurableObjectNamespace,
    sandboxName: string
  ): Promise<void> {
    if (this._restored) return;
    this._restored = true;

    const hostname = this._hostname ?? "localhost";
    try {
      const sandbox = getSandbox(sandboxBinding, sandboxName);
      const ports = await sandbox.getExposedPorts(hostname);
      if (ports.length > 0) {
        // Use the first active port, or fall back to the first port
        const active = ports.find((p) => p.status === "active") ?? ports[0];
        this._url = active.url;
        this._port = active.port;
      }
    } catch {
      // Sandbox may not be running yet — no ports to restore
    }
  }

  /** Capture the hostname from the first incoming request. */
  captureHostname(host: string): void {
    if (!this._hostname) {
      this._hostname = host;
    }
  }

  /** Get the current preview URL and port, if any. */
  getPreviewUrl(): { url: string; port: number } | null {
    if (this._url && this._port) {
      return { url: this._url, port: this._port };
    }
    return null;
  }

  /**
   * Expose a port from the sandbox and broadcast the preview URL.
   */
  async exposePort(
    sandboxBinding: DurableObjectNamespace,
    sandboxName: string,
    port: number,
    broadcast: (msg: string) => void
  ): Promise<{ url: string; port: number }> {
    const sandbox = getSandbox(sandboxBinding, sandboxName);
    const hostname = this._hostname ?? "localhost";
    const exposed = await sandbox.exposePort(port, { hostname });

    this._url = exposed.url;
    this._port = port;

    const msg: ServerMessage = {
      type: "preview-url",
      url: exposed.url,
      port
    };
    broadcast(JSON.stringify(msg));

    return { url: exposed.url, port };
  }
}
