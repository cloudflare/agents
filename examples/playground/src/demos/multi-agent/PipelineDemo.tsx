import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  HighlightedJson,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type {
  PipelineOrchestratorAgent,
  PipelineState,
  PipelineResult
} from "./pipeline-agent";
import type { StageResult } from "./stage-agents";

const codeSections: CodeSection[] = [
  {
    title: "Chain agents into a pipeline",
    description:
      "Each stage processes data and passes it to the next agent via getAgentByName(). An orchestrator agent drives the pipeline and collects results from each stage.",
    code: `import { Agent, callable, getAgentByName } from "agents";

class PipelineOrchestratorAgent extends Agent<Env> {
  @callable()
  async runPipeline(input: string) {
    const stages = [];

    const validator = await getAgentByName(
      this.env.ValidatorStageAgent, "validator"
    );
    const validated = await validator.process(input);
    stages.push(validated);

    const transformer = await getAgentByName(
      this.env.TransformStageAgent, "transformer"
    );
    const transformed = await transformer.process(validated.output);
    stages.push(transformed);

    const enricher = await getAgentByName(
      this.env.EnrichStageAgent, "enricher"
    );
    const enriched = await enricher.process(transformed.output);
    stages.push(enriched);

    return { input, stages };
  }
}`
  },
  {
    title: "Stage agents are plain Durable Objects",
    description:
      "Each stage is a separate agent with a process() method. No @callable needed — the orchestrator calls them directly via Durable Object RPC. Each stage is isolated and independently scalable.",
    code: `class ValidatorStageAgent extends Agent<Env> {
  async process(input: string) {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Input cannot be empty");
    return {
      stage: "validate",
      input,
      output: { trimmed, lowercased: trimmed.toLowerCase() },
    };
  }
}

class TransformStageAgent extends Agent<Env> {
  async process(validated: { trimmed: string }) {
    return {
      stage: "transform",
      output: {
        uppercase: validated.trimmed.toUpperCase(),
        reversed: validated.trimmed.split("").reverse().join(""),
      },
    };
  }
}`
  }
];

const PRESETS = [
  "The quick brown fox jumps over the lazy dog",
  "Cloudflare Workers run at the edge",
  "Hello World from the Agents SDK"
];

const STAGE_LABELS: Record<string, string> = {
  validate: "Validate",
  transform: "Transform",
  enrich: "Enrich"
};

function StageCard({ stage }: { stage: StageResult }) {
  return (
    <div className="border border-kumo-line rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-kumo-default">
          {STAGE_LABELS[stage.stage] || stage.stage}
        </span>
        <span className="text-xs text-kumo-inactive">{stage.duration}ms</span>
      </div>
      <HighlightedJson data={stage.output} />
    </div>
  );
}

export function PipelineDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [input, setInput] = useState(PRESETS[0]);
  const [isRunning, setIsRunning] = useState(false);
  const [lastRun, setLastRun] = useState<PipelineResult | null>(null);

  const agent = useAgent<PipelineOrchestratorAgent, PipelineState>({
    agent: "pipeline-orchestrator-agent",
    name: `pipeline-demo-${userId}`,
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onStateUpdate: (newState) => {
      if (newState?.lastRun) setLastRun(newState.lastRun);
    }
  });

  const handleRun = async () => {
    if (!input.trim()) return;
    setIsRunning(true);
    addLog("out", "runPipeline", { input });

    try {
      const result = await agent.call("runPipeline", [input]);
      const typed = result as PipelineResult;
      addLog("in", "result", {
        stages: typed.stages.length,
        totalMs: typed.totalDuration
      });
      setLastRun(typed);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <DemoWrapper
      title="Pipeline Pattern"
      description={
        <>
          Data flows through a chain of agents, each performing a specific
          transformation and passing the result to the next stage via{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            getAgentByName()
          </code>
          . Each stage is a separate Durable Object, so stages are isolated and
          independently scalable. Enter some text and run it through the
          validate, transform, enrich pipeline.
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
              <Text variant="heading3">Pipeline Input</Text>
            </div>
            <Input
              aria-label="Text to process"
              type="text"
              value={input}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setInput(e.target.value)
              }
              onKeyDown={(e: React.KeyboardEvent) =>
                e.key === "Enter" && handleRun()
              }
              className="w-full mb-3"
              placeholder="Enter text to process..."
            />
            <div className="flex flex-wrap gap-2 mb-4">
              {PRESETS.map((preset, i) => (
                <Button
                  key={i}
                  variant="ghost"
                  size="xs"
                  onClick={() => setInput(preset)}
                >
                  Preset {i + 1}
                </Button>
              ))}
            </div>
            <Button
              variant="primary"
              onClick={handleRun}
              disabled={isRunning || !input.trim()}
              className="w-full"
            >
              {isRunning ? "Running Pipeline..." : "Run Pipeline"}
            </Button>
          </Surface>

          {/* Pipeline visualization */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <Text variant="heading3">Pipeline Stages</Text>
              {lastRun && (
                <span className="text-xs text-kumo-subtle">
                  {lastRun.totalDuration}ms total
                </span>
              )}
            </div>

            {/* Stage flow diagram */}
            <div className="flex items-center justify-center gap-2 mb-4 text-xs text-kumo-subtle">
              <span className="bg-kumo-control px-2 py-1 rounded text-kumo-default">
                Validate
              </span>
              <span>→</span>
              <span className="bg-kumo-control px-2 py-1 rounded text-kumo-default">
                Transform
              </span>
              <span>→</span>
              <span className="bg-kumo-control px-2 py-1 rounded text-kumo-default">
                Enrich
              </span>
            </div>

            {lastRun ? (
              <div className="space-y-3">
                {lastRun.stages.map((stage) => (
                  <StageCard key={stage.stage} stage={stage} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-kumo-inactive text-center py-4">
                Run the pipeline to see stage results
              </p>
            )}
          </Surface>
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
