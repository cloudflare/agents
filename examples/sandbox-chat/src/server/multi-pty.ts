// ═══════════════════════════════════════════════════════════════════════
// multi-pty.ts — ARCHIVED REFERENCE (not imported or used)
// ═══════════════════════════════════════════════════════════════════════
//
// This file preserves the shared-PTY fan-out approach that was originally
// embedded in SandboxChatAgent. It is kept as a reference so future
// readers can see the design that was tried and understand why it was
// replaced with the simpler dual-terminal model (see pty.ts).
//
// ## What it did
//
// A single upstream PTY WebSocket connected to the sandbox container.
// All browser terminal clients connected to the agent Durable Object
// with a `?mode=terminal` query param, were tagged as "terminal" via
// `getConnectionTags` (hibernation-safe), and received fan-out of the
// PTY output. Keystrokes from any client were forwarded back to the
// single PTY.
//
// The agent's `exec` tool also sent commands through this same PTY, so
// the user could see agent commands executing in real-time. A
// deterministic PS1 prompt marker (derived from `this.name`) detected
// command completion and captured output for the tool result.
//
// A control-state machine (idle / agent / user / interrupt) tracked who
// was "driving" the terminal and broadcast state changes to all clients.
// A user-idle timer transitioned from "user" back to "idle" after 3
// seconds of keyboard inactivity.
//
// ## Why it was removed
//
// 1. **Fragile fan-out**: One upstream PTY → N browser clients is hard
//    to reason about. If the upstream WebSocket drops, all clients lose
//    their session. Reconnection required re-establishing PS1 without
//    re-clearing scrollback, creating subtle state bugs.
//
// 2. **Control-state machine**: The idle/agent/user/interrupt state
//    machine added complexity to `onConnect`, `onClose`, and `onMessage`
//    that obscured the core agent logic. Every WebSocket message had to
//    be classified (binary keystroke? JSON control? resize?) and routed.
//
// 3. **Prompt-marker detection across hibernation**: The PS1 marker had
//    to be deterministic so it survived DO hibernation (the container's
//    bash session keeps the old PS1 even after the DO loses in-memory
//    state). This worked but was non-obvious and fragile — any change to
//    the marker format broke reconnection.
//
// 4. **Terminal tag routing in lifecycle hooks**: `getConnectionTags`,
//    `onConnect`, `onClose`, and `onMessage` all had special terminal
//    branches that prevented calling `super`. This made the agent class
//    harder to understand as an AIChatAgent example.
//
// ## The replacement
//
// - **Agent PTY** (`pty.ts`): A simple class that owns a private PTY.
//   Only the agent calls `exec()`. No fan-out, no control state.
// - **User terminal**: The browser's xterm.js uses `SandboxAddon` to
//   connect directly to the sandbox container — it never routes through
//   the agent DO. This gives the user a fully independent session.
//
// ═══════════════════════════════════════════════════════════════════════

// The code below is extracted verbatim from the original
// SandboxChatAgent class. It references `this.*` members that no longer
// exist — it is not meant to compile.

/*

// ── PTY state (was on SandboxChatAgent) ───────────────────────────

private _ptyWs: WebSocket | null = null;
private _controlState: "idle" | "agent" | "user" | "interrupt" = "idle";
private _userIdleTimer: ReturnType<typeof setTimeout> | null = null;
private _initialClearSent = false;
private _ptyReady: Promise<void> | null = null;
private _ptyReadyResolve: (() => void) | null = null;
private _outputCapture: ((chunk: string) => void) | null = null;

private get _promptMarker(): string {
  return `__AGENT_${this.name.replace(/[^a-z0-9]/gi, "")}_PROMPT__`;
}

// ── Terminal client helpers ───────────────────────────────────────

private *terminalClients() {
  for (const conn of this.getConnections("terminal")) {
    yield conn;
  }
}

private get terminalClientCount(): number {
  let n = 0;
  for (const _conn of this.getConnections("terminal")) n++;
  return n;
}

// ── Control state broadcasting ───────────────────────────────────

private broadcastControl(
  state: "idle" | "agent" | "user" | "interrupt",
  extra?: Record<string, unknown>
) {
  this._controlState = state;
  this.broadcast(JSON.stringify({ type: "control", state, ...extra }));
}

private resetUserIdleTimer() {
  if (this._userIdleTimer) clearTimeout(this._userIdleTimer);
  this._userIdleTimer = setTimeout(() => {
    if (this._controlState === "user") {
      this.broadcastControl("idle");
    }
  }, 3000);
}

// ── Connection tagging ───────────────────────────────────────────

override getConnectionTags(
  conn: Connection,
  ctx: ConnectionContext
): string[] | Promise<string[]> {
  const url = new URL(ctx.request.url);
  if (url.searchParams.get("mode") === "terminal") {
    return ["terminal"];
  }
  return [];
}

// ── PTY WebSocket lifecycle ──────────────────────────────────────

private ensurePty(): Promise<void> {
  if (this._ptyReady) return this._ptyReady;

  this._ptyReady = new Promise<void>((resolve) => {
    this._ptyReadyResolve = resolve;
  });

  (async () => {
    try {
      const sandbox = getSandbox(this.env.Sandbox, this.name) as any;

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
      this._ptyWs = ws;

      const decoder = new TextDecoder();
      let ps1Sent = false;

      ws.addEventListener("message", (event: MessageEvent) => {
        // Fan-out raw data to all terminal clients
        for (const conn of this.terminalClients()) {
          try {
            if (event.data instanceof ArrayBuffer) {
              conn.send(event.data);
            } else {
              conn.send(event.data as string);
            }
          } catch {
            // Connection gone — cleaned up in onClose
          }
        }

        if (event.data instanceof ArrayBuffer) {
          const text = decoder.decode(event.data);
          this._outputCapture?.(text);

          if (!ps1Sent && this._ptyWs) {
            ps1Sent = true;
            const ps1Cmd = ` export PS1='\\[\\e]9999;${this._promptMarker}\\007\\]% ' \n`;
            this._ptyWs.send(new TextEncoder().encode(ps1Cmd));
          }

          if (this._ptyReadyResolve && text.includes(this._promptMarker)) {
            if (!this._initialClearSent) {
              this._initialClearSent = true;
              this._ptyWs?.send(
                new TextEncoder().encode("\x1b[2J\x1b[H")
              );
            }
            const resolve = this._ptyReadyResolve;
            this._ptyReadyResolve = null;
            resolve();
          }
        }
      });

      ws.addEventListener("close", () => {
        this._ptyWs = null;
        this._ptyReady = null;
        this._ptyReadyResolve = null;
        const msg = JSON.stringify({ type: "exit", code: 0 });
        for (const conn of this.terminalClients()) {
          try {
            conn.send(msg);
          } catch {
            // ignore
          }
        }
      });

      ws.addEventListener("error", () => {
        this._ptyWs = null;
        this._ptyReady = null;
        this._ptyReadyResolve = null;
      });
    } catch (err) {
      this._ptyReady = null;
      this._ptyReadyResolve = null;
      throw err;
    }
  })().catch((err: unknown) => {
    console.error("[SandboxChatAgent] ensurePty failed:", err);
  });

  return this._ptyReady;
}

// ── Command execution via shared PTY ─────────────────────────────

private ptyExec(
  command: string,
  timeoutMs = 30000
): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let captured = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (timedOut: boolean) => {
      this._outputCapture = null;
      this.broadcastControl("idle");
      if (timer) clearTimeout(timer);
      const clean = captured.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      const lines = clean.split(/\r?\n/);
      const start = lines.findIndex((l) =>
        l.includes(command.trim().slice(0, 20))
      );
      let end = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(this._promptMarker)) {
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

    this._outputCapture = (chunk: string) => {
      captured += chunk;
      if (captured.includes(this._promptMarker)) {
        finish(false);
      }
    };

    if (this._ptyWs) {
      this.broadcastControl("agent");
      this._ptyWs.send(new TextEncoder().encode(command + "\n"));
    } else {
      finish(true);
    }
  });
}

private teardownPty() {
  if (this._ptyWs) {
    try {
      this._ptyWs.close();
    } catch {
      // ignore
    }
    this._ptyWs = null;
  }
  this._ptyReady = null;
  this._ptyReadyResolve = null;
}

// ── Terminal routing in connection lifecycle ──────────────────────

override async onConnect(
  conn: Connection,
  ctx: ConnectionContext
): Promise<void> {
  const url = new URL(ctx.request.url);
  if (url.searchParams.get("mode") === "terminal") {
    this.ensurePty().catch((err: unknown) => {
      console.error("[SandboxChatAgent] ensurePty failed:", err);
    });
    return; // Don't call super — skip agent protocol
  }
  return super.onConnect(conn, ctx);
}

override onClose(
  conn: Connection,
  code: number,
  reason: string,
  wasClean: boolean
): void {
  if (conn.tags.includes("terminal")) {
    if (this.terminalClientCount === 0) {
      if (this._userIdleTimer) {
        clearTimeout(this._userIdleTimer);
        this._userIdleTimer = null;
      }
      this._controlState = "idle";
    }
    return;
  }
  super.onClose(conn, code, reason, wasClean);
}

override onMessage(conn: Connection, message: WSMessage): void {
  if (conn.tags.includes("terminal")) {
    // Binary = keystrokes → forward to PTY
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
      if (this._ptyWs) {
        try {
          this._ptyWs.send(
            message instanceof ArrayBuffer
              ? message
              : ((message as ArrayBufferView).buffer as ArrayBuffer)
          );
        } catch {
          // ignore
        }
      }
      if (this._controlState === "idle") {
        this.broadcastControl("user");
      }
      if (this._controlState === "user" || this._controlState === "idle") {
        this.resetUserIdleTimer();
      }
      return;
    }

    // Text = control messages (resize, takeover, resume)
    if (typeof message === "string") {
      try {
        const msg = JSON.parse(message) as Record<string, unknown>;

        if (msg.type === "resize" && this._ptyWs) {
          this._ptyWs.send(message);
          return;
        }

        if (msg.type === "takeover") {
          this.broadcastControl("user");
          if (this._userIdleTimer) clearTimeout(this._userIdleTimer);
          this._userIdleTimer = null;
          return;
        }

        if (msg.type === "resume") {
          this.broadcastControl("idle");
          return;
        }
      } catch {
        // Not JSON — ignore
      }
    }
    return;
  }

  super.onMessage(conn, message);
}

*/
