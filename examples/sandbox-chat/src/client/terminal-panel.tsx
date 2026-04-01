import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SandboxAddon } from "@cloudflare/sandbox/xterm";

interface TerminalPanelProps {
  agentName: string;
  isConnected: boolean;
}

/**
 * User-interactive terminal that connects directly to the sandbox
 * container via SandboxAddon. This is independent of the agent's
 * private PTY — the user gets their own bash session.
 */
export function TerminalPanel({ agentName, isConnected }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const addonRef = useRef<SandboxAddon | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  useEffect(() => {
    if (!containerRef.current || !isConnected) return;

    let term: Terminal;
    let fitAddon: FitAddon;
    let sandbox: SandboxAddon;
    (async () => {
      const [{ Terminal }, { FitAddon }, { SandboxAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@cloudflare/sandbox/xterm")
      ]);

      // Import xterm CSS dynamically
      await import("@xterm/xterm/css/xterm.css");

      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        theme: {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#e6edf3",
          selectionBackground: "#264f78"
        }
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Connect directly to the sandbox — not through the agent DO.
      // The user gets their own independent bash session.
      sandbox = new SandboxAddon({
        getWebSocketUrl: ({ sandboxId, origin }) => {
          return `${origin}/ws/terminal?id=${encodeURIComponent(sandboxId)}`;
        },
        reconnect: true,
        onStateChange: (state) => {
          console.log("[terminal]", state);
        }
      });
      term.loadAddon(sandbox);

      if (!containerRef.current) return;
      term.open(containerRef.current);
      fitAddon.fit();
      sandbox.connect({ sandboxId: agentName });

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      addonRef.current = sandbox;

      // Re-fit after a frame to handle cases where the container
      // wasn't fully laid out yet (e.g. CSS display toggle).
      requestAnimationFrame(() => fitAddon.fit());
    })();

    const observer = new ResizeObserver(() => fitAddonRef.current?.fit());
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      addonRef.current?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
      addonRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isConnected, agentName]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0d1117]">
      {/* xterm container */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden p-1" />
    </div>
  );
}
