import { useAgent } from "agents/react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Button, Surface, CodeBlock, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { ConnectionStatus } from "../../components";
import { useUserId } from "../../hooks";
import type { ReadonlyAgent, ReadonlyAgentState } from "./readonly-agent";

const AGENT_NAME = "readonly-agent";

const initialState: ReadonlyAgentState = {
  counter: 0,
  lastUpdatedBy: null
};

interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

const MAX_TOASTS = 5;

/** A single connection panel — editor or viewer depending on `mode`. */
function ConnectionPanel({ mode }: { mode: "edit" | "view" }) {
  const userId = useUserId();
  const isViewer = mode === "view";
  const [state, setState] = useState<ReadonlyAgentState>(initialState);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isReadonly, setIsReadonly] = useState(isViewer);
  const nextId = useRef(0);

  const addToast = useCallback((message: string, kind: "error" | "info") => {
    const id = nextId.current++;
    setToasts((prev) => {
      // Deduplicate: if the most recent toast has the same message & kind, skip
      const last = prev[prev.length - 1];
      if (last && last.message === message && last.kind === kind) return prev;
      // Cap the list so it doesn't grow unbounded
      const next = [...prev, { id, message, kind }];
      return next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next;
    });
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2500);
  }, []);

  const agent = useAgent<ReadonlyAgent, ReadonlyAgentState>({
    agent: AGENT_NAME,
    name: `readonly-demo-${userId}`,
    // The viewer connects with ?mode=view, which the agent checks in shouldConnectionBeReadonly
    query: isViewer ? { mode: "view" } : undefined,
    onStateUpdate: (newState) => {
      if (newState) setState(newState);
    },
    onStateUpdateError: (error) => {
      addToast(error, "error");
    }
  });

  const connected = agent.readyState === WebSocket.OPEN;

  // Refresh permissions when connection opens
  const refreshPermissions = useCallback(async () => {
    if (!connected) return;
    try {
      const result = await agent.call("getPermissions");
      setIsReadonly(!result.canEdit);
    } catch {
      // ignore — connection may not be ready yet
    }
  }, [agent, connected]);

  useEffect(() => {
    refreshPermissions();
  }, [refreshPermissions]);

  const showError = (msg: string) => addToast(msg, "error");
  const showInfo = (msg: string) => addToast(msg, "info");

  const handleIncrement = async () => {
    try {
      await agent.call("increment");
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDecrement = async () => {
    try {
      await agent.call("decrement");
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReset = async () => {
    try {
      await agent.call("resetCounter");
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleClientSetState = () => {
    agent.setState({
      ...state,
      counter: state.counter + 10,
      lastUpdatedBy: "client"
    });
  };

  const handleCheckPermissions = async () => {
    try {
      const result = await agent.call("getPermissions");
      setIsReadonly(!result.canEdit);
      showInfo(`canEdit = ${result.canEdit}`);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleReadonly = async () => {
    try {
      const result = await agent.call("setMyReadonly", [!isReadonly]);
      setIsReadonly(result.readonly);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Surface className="relative p-5 rounded-lg ring ring-kumo-line space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
              isReadonly
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : "bg-green-500/10 text-green-600 dark:text-green-400"
            }`}
          >
            {isReadonly
              ? `${isViewer ? "Viewer" : "Editor"} (readonly)`
              : `${isViewer ? "Viewer" : "Editor"} (read-write)`}
          </span>
          {/* Readonly toggle — inline in the header so it adds no extra height */}
          {isViewer && connected && (
            <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isReadonly}
                onChange={handleToggleReadonly}
                className="h-3.5 w-3.5 rounded border-kumo-line accent-amber-500"
              />
              <span className="text-kumo-subtle">Lock</span>
            </label>
          )}
        </div>
        <ConnectionStatus status={connected ? "connected" : "connecting"} />
      </div>

      {/* Counter */}
      <div className="text-center py-4">
        <span className="tabular-nums">
          <Text variant="heading1">{state.counter}</Text>
        </span>
        <p className="text-xs text-kumo-inactive mt-1">
          {state.lastUpdatedBy
            ? `Last updated by: ${state.lastUpdatedBy}`
            : "\u00A0"}
        </p>
      </div>

      {/* Controls — grouped by mutation mechanism */}
      <div className="space-y-3">
        {/* Callable RPCs that call this.setState() internally */}
        <div>
          <p className="text-[0.65rem] uppercase tracking-wider text-kumo-inactive text-center mb-1.5">
            via @callable()
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="secondary"
              onClick={handleDecrement}
              disabled={!connected}
            >
              &minus;1
            </Button>
            <Button
              variant="primary"
              onClick={handleIncrement}
              disabled={!connected}
            >
              +1
            </Button>
            <Button
              variant="secondary"
              onClick={handleReset}
              disabled={!connected}
            >
              Reset
            </Button>
          </div>
        </div>

        {/* Client-side setState() */}
        <div>
          <p className="text-[0.65rem] uppercase tracking-wider text-kumo-inactive text-center mb-1.5">
            via client setState()
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="secondary"
              onClick={handleClientSetState}
              disabled={!connected}
            >
              +10
            </Button>
          </div>
        </div>

        {/* Non-mutating RPC — always allowed */}
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={handleCheckPermissions}
            disabled={!connected}
          >
            Check Permissions
          </Button>
        </div>
      </div>

      {/* Toasts — stacked bottom-right, absolutely positioned */}
      {toasts.length > 0 && (
        <div className="absolute right-3 bottom-3 z-10 flex flex-col items-end gap-1.5">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`rounded-lg px-3 py-1.5 text-xs shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-right-2 ${
                t.kind === "info"
                  ? "bg-blue-500/10 border border-blue-500/30 text-blue-600 dark:text-blue-400"
                  : "bg-kumo-danger-tint border border-kumo-danger text-kumo-danger"
              }`}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}

      {/* State JSON */}
      <CodeBlock code={JSON.stringify(state, null, 2)} lang="jsonc" />
    </Surface>
  );
}

export function ReadonlyDemo() {
  return (
    <DemoWrapper
      title="Readonly Connections"
      description="Two WebSocket connections to the same agent — one can edit, one can only view. Both receive real-time state updates."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ConnectionPanel mode="edit" />
        <ConnectionPanel mode="view" />
      </div>

      <Surface className="mt-6 p-4 rounded-lg ring ring-kumo-line">
        <div className="mb-2">
          <Text variant="heading3">How it works</Text>
        </div>
        <ul className="space-y-1 text-sm text-kumo-subtle list-disc list-inside">
          <li>
            The <strong>Editor</strong> connects normally. The{" "}
            <strong>Viewer</strong> connects with <code>?mode=view</code> in the
            query string.
          </li>
          <li>
            The agent&apos;s <code>shouldConnectionBeReadonly</code> hook checks
            the query parameter and marks the viewer as readonly.
          </li>
          <li>
            <strong>via @callable()</strong> — the +1, −1, and Reset buttons
            call RPC methods that internally call <code>this.setState()</code>.
            These are <strong>blocked</strong> for the Viewer — the framework
            throws when a readonly connection&apos;s callable tries to write
            state.
          </li>
          <li>
            <strong>via client setState()</strong> — the +10 button calls{" "}
            <code>agent.setState()</code> directly from the client. Also{" "}
            <strong>blocked</strong> for the Viewer — the server rejects it and
            fires <code>onStateUpdateError</code>.
          </li>
          <li>
            <strong>Check Permissions</strong> is a non-mutating RPC that works
            from both connections because it doesn&apos;t call{" "}
            <code>this.setState()</code>.
          </li>
          <li>
            The <strong>Readonly checkbox</strong> on the Viewer calls{" "}
            <code>setMyReadonly()</code> to dynamically toggle the
            connection&apos;s readonly status at runtime. Uncheck it to let the
            Viewer mutate state.
          </li>
        </ul>
      </Surface>
    </DemoWrapper>
  );
}
