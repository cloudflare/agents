import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  HighlightedCode,
  HighlightedJson,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type { StreamingAgent } from "./streaming-agent";

const codeSections: CodeSection[] = [
  {
    title: "Define a streaming method",
    description:
      "Add streaming: true to the @callable decorator. The method receives a StreamingResponse as its first argument — call stream.send() to push chunks and stream.end() to finish.",
    code: `import { Agent, callable, type StreamingResponse } from "agents";

class StreamingAgent extends Agent<Env> {
  @callable({ streaming: true })
  async countdown(stream: StreamingResponse, from: number) {
    for (let i = from; i >= 0; i--) {
      stream.send({ count: i, label: i === 0 ? "Liftoff!" : \`\${i}...\` });
      await new Promise(r => setTimeout(r, 500));
    }
    stream.end({ launched: true });
  }
}`
  },
  {
    title: "Consume the stream on the client",
    description:
      "Pass onChunk, onDone, and onError callbacks as the third argument to agent.call(). Chunks arrive as they are sent from the server.",
    code: `await agent.call("countdown", [5], {
  onChunk: (chunk) => {
    // { count: 4, label: "4..." }
    console.log(chunk);
  },
  onDone: (final) => {
    // { launched: true }
    console.log("Stream complete:", final);
  },
  onError: (error) => {
    console.error("Stream error:", error);
  },
});`
  }
];

export function StreamingDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [chunks, setChunks] = useState<unknown[]>([]);
  const [finalResult, setFinalResult] = useState<unknown>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [count, setCount] = useState("10");
  const [countdown, setCountdown] = useState("5");
  const [errorAfter, setErrorAfter] = useState("3");

  const agent = useAgent<StreamingAgent, {}>({
    agent: "streaming-agent",
    name: `streaming-demo-${userId}`,
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
      description={
        <>
          Add{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            streaming: true
          </code>{" "}
          to any{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            @callable
          </code>{" "}
          decorator to stream data chunk-by-chunk from server to client. The
          method receives a{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            StreamingResponse
          </code>{" "}
          object — call{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            stream.send()
          </code>{" "}
          to push data and{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            stream.end()
          </code>{" "}
          to finish. Try the countdown to see streaming with delays.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Stream Numbers */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Stream Numbers</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Streams numbers from 1 to N synchronously
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Number count"
                type="number"
                value={count}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCount(e.target.value)
                }
                className="w-20"
                min={1}
                max={100}
              />
              <Button
                variant="primary"
                onClick={() => handleStream("streamNumbers", [Number(count)])}
                disabled={isStreaming}
              >
                {isStreaming ? "Streaming..." : `Stream ${count} numbers`}
              </Button>
            </div>
          </Surface>

          {/* Countdown */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Countdown</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Streams a countdown with 500ms delays between numbers
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Countdown start"
                type="number"
                value={countdown}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCountdown(e.target.value)
                }
                className="w-20"
                min={1}
                max={20}
              />
              <Button
                variant="primary"
                onClick={() => handleStream("countdown", [Number(countdown)])}
                disabled={isStreaming}
              >
                {isStreaming ? "Streaming..." : `Countdown from ${countdown}`}
              </Button>
            </div>
          </Surface>

          {/* Stream with Error */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Stream with Error</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Sends N chunks then errors (tests error handling mid-stream)
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Error after N items"
                type="number"
                value={errorAfter}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setErrorAfter(e.target.value)
                }
                className="w-20"
                min={1}
                max={10}
              />
              <Button
                variant="destructive"
                onClick={() =>
                  handleStream("streamWithError", [Number(errorAfter)])
                }
                disabled={isStreaming}
              >
                Error after {errorAfter} chunks
              </Button>
            </div>
          </Surface>

          {/* Stream Output */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">
                Stream Output
                {isStreaming && (
                  <span className="ml-2 text-xs font-normal text-kumo-subtle animate-pulse">
                    receiving...
                  </span>
                )}
              </Text>
            </div>
            <div className="space-y-2">
              <div>
                <span className="text-xs text-kumo-subtle">
                  Chunks ({chunks.length})
                </span>
                {chunks.length === 0 ? (
                  <p className="text-xs text-kumo-inactive">No chunks yet</p>
                ) : (
                  <HighlightedCode
                    code={chunks.map((c) => JSON.stringify(c)).join("\n")}
                    lang="json"
                  />
                )}
              </div>
              {finalResult !== null && (
                <div>
                  <span className="text-xs text-kumo-subtle">Final Result</span>
                  <HighlightedJson data={finalResult} />
                </div>
              )}
            </div>
          </Surface>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
