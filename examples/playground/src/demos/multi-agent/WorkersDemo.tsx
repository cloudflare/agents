import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useLogs, useUserId, useToast } from "../../hooks";
import type { ManagerAgent, ManagerState } from "./manager-agent";
import type { WorkerResult } from "./fanout-worker-agent";

const codeSections: CodeSection[] = [
  {
    title: "Fan out work to parallel agents",
    description:
      "The manager splits work into chunks and spawns worker agents using getAgentByName(). Each worker processes its chunk concurrently as a separate Durable Object, and results are aggregated with Promise.all().",
    code: `import { Agent, callable, getAgentByName } from "agents";

class ManagerAgent extends Agent<Env> {
  @callable()
  async processItems(items: string[], workerCount: number) {
    const chunkSize = Math.ceil(items.length / workerCount);
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const results = await Promise.all(
      chunks.map(async (chunk, i) => {
        const worker = await getAgentByName(
          this.env.FanoutWorkerAgent,
          \`worker-\${i}\`
        );
        return worker.processChunk(\`worker-\${i}\`, chunk);
      })
    );

    return results;
  }
}`
  },
  {
    title: "Worker agents process independently",
    description:
      "Each worker is a separate Durable Object with its own isolated execution. Workers do not need @callable — the manager calls them directly via Durable Object RPC.",
    code: `class FanoutWorkerAgent extends Agent<Env> {
  async processChunk(workerId: string, items: string[]) {
    const processed = items.map(item => {
      return item.toUpperCase();
    });
    return { workerId, items, processed };
  }
}`
  }
];

const PRESETS = [
  "apple, banana, cherry, date, elderberry, fig, grape, honeydew",
  "react, vue, svelte, angular, solid, preact, lit, qwik",
  "paris, london, tokyo, new york, sydney, berlin, rome, cairo, mumbai, toronto, seoul, lisbon"
];

export function WorkersDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [items, setItems] = useState(PRESETS[0]);
  const [workerCount, setWorkerCount] = useState("3");
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastRun, setLastRun] = useState<ManagerState["lastRun"]>(null);

  const agent = useAgent<ManagerAgent, ManagerState>({
    agent: "manager-agent",
    name: `workers-demo-${userId}`,
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onStateUpdate: (newState) => {
      if (newState?.lastRun) setLastRun(newState.lastRun);
    }
  });

  const handleProcess = async () => {
    const parsed = items
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length === 0) return;

    setIsProcessing(true);
    addLog("out", "processItems", {
      items: parsed.length,
      workers: Number(workerCount)
    });

    try {
      const result = await agent.call("processItems", [
        parsed,
        Number(workerCount)
      ]);
      addLog("in", "result", {
        workers: (result as ManagerState["lastRun"])?.workerCount,
        totalMs: (result as ManagerState["lastRun"])?.totalDuration
      });
      setLastRun(result as ManagerState["lastRun"]);
      const run = result as ManagerState["lastRun"];
      toast(
        "Processed by " +
          run?.workerCount +
          " workers in " +
          run?.totalDuration +
          "ms",
        "success"
      );
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <DemoWrapper
      title="Workers Pattern"
      description={
        <>
          A manager agent splits work into chunks and distributes them across
          multiple worker agents using{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            getAgentByName()
          </code>
          . Workers process their chunks concurrently as separate Durable
          Objects, and the manager aggregates results with{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            Promise.all()
          </code>
          . Enter some items below and fan them out.
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
          {/* Input */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Items to Process</Text>
            </div>
            <Input
              aria-label="Comma-separated items"
              type="text"
              value={items}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setItems(e.target.value)
              }
              className="w-full mb-3"
              placeholder="apple, banana, cherry, ..."
            />
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset, i) => (
                <Button
                  key={i}
                  variant="ghost"
                  size="xs"
                  onClick={() => setItems(preset)}
                >
                  Preset {i + 1}
                </Button>
              ))}
            </div>
          </Surface>

          {/* Worker Count */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Workers</Text>
            </div>
            <div className="flex items-center gap-3 mb-4">
              {["1", "2", "3", "4"].map((n) => (
                <Button
                  key={n}
                  variant={workerCount === n ? "primary" : "secondary"}
                  onClick={() => setWorkerCount(n)}
                >
                  {n}
                </Button>
              ))}
            </div>
            <Button
              variant="primary"
              onClick={handleProcess}
              disabled={isProcessing || !items.trim()}
              className="w-full"
            >
              {isProcessing
                ? "Processing..."
                : `Fan out to ${workerCount} worker${workerCount === "1" ? "" : "s"}`}
            </Button>
          </Surface>

          {/* Results */}
          {lastRun && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="flex items-center justify-between mb-4">
                <Text variant="heading3">Results</Text>
                <span className="text-xs text-kumo-subtle">
                  {lastRun.totalDuration}ms total
                </span>
              </div>
              <div className="space-y-4">
                {lastRun.results.map((worker: WorkerResult) => (
                  <div
                    key={worker.workerId}
                    className="border border-kumo-line rounded p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-xs text-kumo-subtle">
                        {worker.workerId}
                      </code>
                      <span className="text-xs text-kumo-inactive">
                        {worker.duration}ms
                      </span>
                    </div>
                    <div className="space-y-1">
                      {worker.processed.map((result: string, j: number) => (
                        <div
                          key={j}
                          className="text-sm text-kumo-default bg-kumo-elevated rounded px-2 py-1"
                        >
                          {result}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Surface>
          )}
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
