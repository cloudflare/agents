import { getSandbox, type PtyOptions } from "@cloudflare/sandbox";

/** Narrow type for the sandbox's terminal() method (not on ISandbox). */
interface SandboxWithTerminal {
  terminal(request: Request, options?: PtyOptions): Promise<Response>;
}
/**
 * A private PTY session used exclusively by the agent to execute
 * commands inside the sandbox container.
 *
 * Unlike the previous shared-PTY approach (see multi-pty.ts), this
 * class has no fan-out to browser clients, no control-state machine,
 * and no terminal connection tagging. It simply opens a WebSocket to
 * the sandbox's terminal endpoint, sets a deterministic PS1 prompt
 * marker, and provides an `exec()` method that sends a command and
 * captures the output until the marker reappears.
 *
 * The user gets their own independent terminal via SandboxAddon on
 * the client side — it connects directly to the sandbox, bypassing
 * the agent entirely.
 */
export class AgentPty {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private outputCapture: ((chunk: string) => void) | null = null;
  private initialClearSent = false;
  private execQueue: Promise<{ output: string; timedOut: boolean }> =
    Promise.resolve({ output: "", timedOut: false });

  /**
   * Deterministic prompt marker derived from the sandbox name.
   * Must survive DO hibernation — the container's bash session keeps
   * the old PS1 even after the DO loses in-memory state.
   */
  private readonly promptMarker: string;

  private readonly sandboxBinding: DurableObjectNamespace;
  private readonly sandboxName: string;

  constructor(sandboxBinding: DurableObjectNamespace, sandboxName: string) {
    this.sandboxBinding = sandboxBinding;
    this.sandboxName = sandboxName;
    this.promptMarker = `__AGENT_${sandboxName.replace(/[^a-z0-9]/gi, "")}_PROMPT__`;
  }

  /**
   * Ensure the PTY WebSocket is connected and PS1 is initialised.
   * Returns a promise that resolves once the terminal is ready.
   * Subsequent calls return the same promise until the PTY is closed.
   */
  ensureReady(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    (async () => {
      try {
        const sandbox = getSandbox(
          this.sandboxBinding,
          this.sandboxName
        ) as unknown as SandboxWithTerminal;

        const req = new Request("https://sandbox/terminal", {
          headers: { Upgrade: "websocket", Connection: "Upgrade" }
        });
        const resp = (await sandbox.terminal(req, {
          cols: 220,
          rows: 50
        })) as Response;

        const ws = resp.webSocket;
        if (!ws)
          throw new Error("sandbox.terminal() did not return a WebSocket");

        ws.accept();
        this.ws = ws;

        const decoder = new TextDecoder();
        let ps1Sent = false;

        ws.addEventListener("message", (event: MessageEvent) => {
          if (!(event.data instanceof ArrayBuffer)) return;

          const text = decoder.decode(event.data);
          this.outputCapture?.(text);

          // Send PS1 export once on first output (shell is ready)
          if (!ps1Sent && this.ws) {
            ps1Sent = true;
            const ps1Cmd = ` export PS1='\\[\\e]9999;${this.promptMarker}\\007\\]% ' \n`;
            this.ws.send(new TextEncoder().encode(ps1Cmd));
          }

          // Detect marker to know PS1 initialisation completed
          if (this.readyResolve && text.includes(this.promptMarker)) {
            if (!this.initialClearSent) {
              this.initialClearSent = true;
              this.ws?.send(new TextEncoder().encode("\x1b[2J\x1b[H"));
            }
            const resolve = this.readyResolve;
            this.readyResolve = null;
            resolve();
          }
        });

        ws.addEventListener("close", () => {
          this.ws = null;
          this.ready = null;
          this.readyResolve = null;
        });

        ws.addEventListener("error", () => {
          this.ws = null;
          this.ready = null;
          this.readyResolve = null;
        });
      } catch (err) {
        this.ready = null;
        this.readyResolve = null;
        throw err;
      }
    })().catch((err: unknown) => {
      console.error("[AgentPty] ensureReady failed:", err);
    });

    return this.ready;
  }

  /**
   * Run a shell command through the PTY. Commands are queued so
   * that only one runs at a time — each waits for the previous
   * to finish before sending its keystrokes.
   */
  async exec(
    command: string,
    timeoutMs = 30000
  ): Promise<{ output: string; timedOut: boolean }> {
    const prev = this.execQueue;
    const next = prev.then(
      () => this._execImmediate(command, timeoutMs),
      () => this._execImmediate(command, timeoutMs)
    );
    this.execQueue = next;
    return next;
  }

  /**
   * Internal — execute a single command. Must only be called when
   * no other command is in flight (enforced by the queue).
   */
  private async _execImmediate(
    command: string,
    timeoutMs: number
  ): Promise<{ output: string; timedOut: boolean }> {
    await this.ensureReady();

    return new Promise((resolve) => {
      let captured = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (timedOut: boolean) => {
        this.outputCapture = null;
        if (timer) clearTimeout(timer);

        // Strip ANSI escape codes
        // eslint-disable-next-line no-control-regex
        const clean = captured.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

        // Drop the echoed command line (first line) and the trailing prompt
        const lines = clean.split(/\r?\n/);
        const start = lines.findIndex((l) =>
          l.includes(command.trim().slice(0, 20))
        );
        let end = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes(this.promptMarker)) {
            end = i;
            break;
          }
        }
        const output = lines
          .slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : undefined)
          .join("\n")
          .trim();
        resolve({ output, timedOut });
      };

      timer = setTimeout(() => finish(true), timeoutMs);

      this.outputCapture = (chunk: string) => {
        captured += chunk;
        if (captured.includes(this.promptMarker)) {
          finish(false);
        }
      };

      if (this.ws) {
        this.ws.send(new TextEncoder().encode(command + "\n"));
      } else {
        finish(true);
      }
    });
  }
}
