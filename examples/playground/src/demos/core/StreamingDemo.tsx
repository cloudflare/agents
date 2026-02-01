import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { StreamingAgent } from "./streaming-agent";

export function StreamingDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [chunks, setChunks] = useState<unknown[]>([]);
  const [finalResult, setFinalResult] = useState<unknown>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [count, setCount] = useState("10");
  const [countdown, setCountdown] = useState("5");
  const [errorAfter, setErrorAfter] = useState("3");

  const agent = useAgent<StreamingAgent, {}>({
    agent: "streaming-agent",
    name: "streaming-demo",
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const handleStream = async (method: string, args: unknown[]) => {
    setChunks([]);
    setFinalResult(null);
    setIsStreaming(true);
    addLog("out", "stream_start", { method, args });

    try {
      // Use type assertion for dynamic streaming method calls
      await (
        agent.call as (
          m: string,
          a?: unknown[],
          opts?: unknown
        ) => Promise<unknown>
      )(method, args, {
        onChunk: (chunk: unknown) => {
          addLog("in", "chunk", chunk);
          setChunks((prev) => [...prev, chunk]);
        },
        onDone: (final: unknown) => {
          addLog("in", "stream_done", final);
          setFinalResult(final);
          setIsStreaming(false);
        },
        onError: (error: string) => {
          addLog("error", "stream_error", error);
          setIsStreaming(false);
        }
      });
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      setIsStreaming(false);
    }
  };

  return (
    <DemoWrapper
      title="Streaming RPC"
      description="Stream data from the agent to the client in real-time using @callable({ streaming: true })."
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

          {/* Stream Numbers */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Stream Numbers</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Streams numbers from 1 to N synchronously
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="input w-20"
                min="1"
                max="100"
              />
              <button
                type="button"
                onClick={() => handleStream("streamNumbers", [Number(count)])}
                disabled={isStreaming}
                className="btn btn-primary"
              >
                {isStreaming ? "Streaming..." : `Stream ${count} numbers`}
              </button>
            </div>
          </div>

          {/* Countdown */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Countdown</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Streams a countdown with 500ms delays between numbers
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                value={countdown}
                onChange={(e) => setCountdown(e.target.value)}
                className="input w-20"
                min="1"
                max="20"
              />
              <button
                type="button"
                onClick={() => handleStream("countdown", [Number(countdown)])}
                disabled={isStreaming}
                className="btn btn-primary"
              >
                {isStreaming ? "Streaming..." : `Countdown from ${countdown}`}
              </button>
            </div>
          </div>

          {/* Stream with Error */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Stream with Error</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Sends N chunks then errors (tests error handling mid-stream)
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                value={errorAfter}
                onChange={(e) => setErrorAfter(e.target.value)}
                className="input w-20"
                min="1"
                max="10"
              />
              <button
                type="button"
                onClick={() =>
                  handleStream("streamWithError", [Number(errorAfter)])
                }
                disabled={isStreaming}
                className="btn btn-danger"
              >
                Error after {errorAfter} chunks
              </button>
            </div>
          </div>

          {/* Stream Output */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">
              Stream Output
              {isStreaming && (
                <span className="ml-2 text-xs font-normal text-neutral-500 animate-pulse">
                  receiving...
                </span>
              )}
            </h3>
            <div className="space-y-2">
              <div>
                <label htmlFor="chunks" className="text-xs text-neutral-500">
                  Chunks ({chunks.length})
                </label>
                <div className="bg-neutral-50 dark:bg-neutral-900 rounded p-2 max-h-40 overflow-y-auto">
                  {chunks.length === 0 ? (
                    <p className="text-xs text-neutral-400">No chunks yet</p>
                  ) : (
                    <div className="space-y-1">
                      {chunks.map((chunk, i) => (
                        <div key={i} className="text-xs font-mono">
                          {JSON.stringify(chunk)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {finalResult !== null && (
                <div>
                  <label
                    htmlFor="finalResult"
                    className="text-xs text-neutral-500"
                  >
                    Final Result
                  </label>
                  <pre className="text-xs bg-green-50 p-2 rounded">
                    {JSON.stringify(finalResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
