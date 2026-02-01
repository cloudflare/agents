import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { CallableAgent } from "./callable-agent";

export function CallableDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [methods, setMethods] = useState<
    Array<{ name: string; description?: string }>
  >([]);
  const [argA, setArgA] = useState("5");
  const [argB, setArgB] = useState("3");
  const [echoMessage, setEchoMessage] = useState("Hello, Agent!");
  const [delayMs, setDelayMs] = useState("1000");
  const [errorMessage, setErrorMessage] = useState("Test error");
  const [lastResult, setLastResult] = useState<string | null>(null);

  const agent = useAgent<CallableAgent, {}>({
    agent: "callable-agent",
    name: "callable-demo",
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const handleCall = async (method: string, args: unknown[]) => {
    addLog("out", "call", { method, args });
    setLastResult(null);
    try {
      // Use type assertion for dynamic method calls
      const result = await (
        agent.call as (m: string, a?: unknown[]) => Promise<unknown>
      )(method, args);
      addLog("in", "result", result);
      setLastResult(JSON.stringify(result, null, 2));
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      addLog("error", "error", error);
      setLastResult(`Error: ${error}`);
      throw e;
    }
  };

  const handleListMethods = async () => {
    try {
      const result = (await handleCall("listMethods", [])) as Array<{
        name: string;
        description?: string;
      }>;
      setMethods(result);
    } catch {
      // Error already logged
    }
  };

  return (
    <DemoWrapper
      title="Callable Methods"
      description="Expose agent methods as RPC endpoints using the @callable decorator."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
          </div>

          {/* Math Operations */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Math Operations</h3>
            <div className="flex gap-2 mb-3">
              <input
                type="number"
                value={argA}
                onChange={(e) => setArgA(e.target.value)}
                className="input w-20"
              />
              <input
                type="number"
                value={argB}
                onChange={(e) => setArgB(e.target.value)}
                className="input w-20"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleCall("add", [Number(argA), Number(argB)])}
                className="btn btn-primary"
              >
                add({argA}, {argB})
              </button>
              <button
                type="button"
                onClick={() =>
                  handleCall("multiply", [Number(argA), Number(argB)])
                }
                className="btn btn-secondary"
              >
                multiply({argA}, {argB})
              </button>
            </div>
          </div>

          {/* Echo */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Echo</h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={echoMessage}
                onChange={(e) => setEchoMessage(e.target.value)}
                className="input flex-1"
              />
              <button
                type="button"
                onClick={() => handleCall("echo", [echoMessage])}
                className="btn btn-primary"
              >
                Echo
              </button>
            </div>
          </div>

          {/* Async Operation */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Async Operation</h3>
            <div className="flex gap-2">
              <input
                type="number"
                value={delayMs}
                onChange={(e) => setDelayMs(e.target.value)}
                className="input w-24"
                placeholder="ms"
              />
              <button
                type="button"
                onClick={() => handleCall("slowOperation", [Number(delayMs)])}
                className="btn btn-primary"
              >
                slowOperation({delayMs})
              </button>
            </div>
            <p className="text-xs text-neutral-500 mt-2">
              Simulates a slow operation with configurable delay
            </p>
          </div>

          {/* Error Handling */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Error Handling</h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={errorMessage}
                onChange={(e) => setErrorMessage(e.target.value)}
                className="input flex-1"
              />
              <button
                type="button"
                onClick={() =>
                  handleCall("throwError", [errorMessage]).catch(() => {})
                }
                className="btn btn-danger"
              >
                Throw Error
              </button>
            </div>
          </div>

          {/* Utility */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Utility Methods</h3>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => handleCall("getTimestamp", [])}
                className="btn btn-secondary"
              >
                getTimestamp()
              </button>
              <button
                type="button"
                onClick={handleListMethods}
                className="btn btn-secondary"
              >
                listMethods()
              </button>
            </div>
          </div>

          {/* Available Methods */}
          {methods.length > 0 && (
            <div className="card p-4">
              <h3 className="font-semibold mb-4">Available Methods</h3>
              <div className="space-y-1 text-sm">
                {methods.map((m) => (
                  <div
                    key={m.name}
                    className="flex justify-between py-1 border-b border-neutral-100 last:border-0"
                  >
                    <code className="font-mono">{m.name}</code>
                    {m.description && (
                      <span className="text-neutral-500 text-xs">
                        {m.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last Result */}
          {lastResult && (
            <div className="card p-4">
              <h3 className="font-semibold mb-2">Last Result</h3>
              <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 p-3 rounded overflow-x-auto">
                {lastResult}
              </pre>
            </div>
          )}
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
