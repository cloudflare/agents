import { useAgent } from "agents/react";
import { useState, useCallback } from "react";
import { Button, Input, Badge, Text } from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents
} from "@cloudflare/agents-ui";
import type { ConnectionStatus } from "@cloudflare/agents-ui";
import type {
  ResearchAgent,
  ProgressMessage,
  ResearchStep,
  AgentState
} from "./server";

type StepStatus = "pending" | "running" | "complete" | "skipped";

type StepInfo = {
  name: string;
  status: StepStatus;
  result?: string;
};

export default function App() {
  const [topic, setTopic] = useState("quantum computing");
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [fiberId, setFiberId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "running" | "complete" | "cancelled" | "recovered"
  >("idle");
  const [results, setResults] = useState<ResearchStep[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");

  const agent = useAgent<ResearchAgent, AgentState>({
    agent: "research-agent",
    onMessage: (message) => {
      try {
        const raw = typeof message === "string" ? message : message.data;
        const msg = JSON.parse(raw as string) as ProgressMessage;

        switch (msg.type) {
          case "research:started":
            setFiberId(msg.fiberId);
            setStatus("running");
            setResults([]);
            setSteps(
              msg.steps.map((name, i) => ({
                name,
                status: i === 0 ? "running" : "pending"
              }))
            );
            break;

          case "research:step":
            setSteps((prev) =>
              prev.map((s, i) => {
                if (i === msg.stepIndex)
                  return {
                    ...s,
                    status: "complete",
                    result: msg.result
                  };
                if (i === msg.stepIndex + 1) return { ...s, status: "running" };
                return s;
              })
            );
            break;

          case "research:recovered":
            setStatus("recovered");
            setSteps((prev) =>
              prev.map((s, i) => {
                if (i < msg.skippedSteps) return { ...s, status: "skipped" };
                if (i === msg.skippedSteps) return { ...s, status: "running" };
                return { ...s, status: "pending" };
              })
            );
            setTimeout(() => setStatus("running"), 1500);
            break;

          case "research:complete":
            setStatus("complete");
            setResults(msg.results);
            break;

          case "research:cancelled":
            setStatus("cancelled");
            break;

          case "research:failed":
            setStatus("idle");
            break;
        }
      } catch {
        // Non-JSON messages (state sync, etc.)
      }
    },
    onOpen: () => setConnectionStatus("connected"),
    onClose: () => setConnectionStatus("disconnected")
  });

  const handleStart = useCallback(async () => {
    if (!topic.trim() || !agent) return;
    await agent.call("startResearch", [topic.trim()]);
  }, [topic, agent]);

  const handleCancel = useCallback(async () => {
    if (!agent) return;
    await agent.call("cancelResearch", []);
  }, [agent]);

  const handleKillAndRecover = useCallback(async () => {
    if (!agent) return;
    setStatus("recovered");
    await agent.call("simulateKillAndRecover", []);
    // Recovery is async — the fiber restarts in the background
    // and broadcasts progress updates as it resumes
    setTimeout(() => {
      if (status === "recovered") setStatus("running");
    }, 2000);
  }, [agent, status]);

  const isRunning = status === "running" || status === "recovered";

  return (
    <div className="flex min-h-screen flex-col bg-kumo-bg-base">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-kumo-line px-6 py-3">
        <div className="flex items-center gap-3">
          <Text variant="heading2">Long-Running Agent</Text>
          <Badge variant="beta">Fibers</Badge>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionIndicator status={connectionStatus} />
          <ModeToggle />
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
        {/* Input */}
        <div className="rounded-lg border border-kumo-line p-4">
          <Text variant="heading3">Research Topic</Text>
          <div className="mt-3 flex gap-2">
            <Input
              className="flex-1"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Enter a research topic..."
              disabled={isRunning}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleStart();
              }}
            />
            {isRunning ? (
              <Button variant="destructive" onClick={handleCancel}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handleStart}
                disabled={!topic.trim()}
              >
                Start Research
              </Button>
            )}
          </div>
        </div>

        {/* Steps */}
        {steps.length > 0 && (
          <div className="rounded-lg border border-kumo-line p-4">
            <div className="flex items-center justify-between">
              <Text variant="heading3">Progress</Text>
              {fiberId && (
                <span className="font-mono text-xs text-kumo-inactive">
                  {fiberId.slice(0, 8)}...
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-2">
              {steps.map((step, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 rounded-md border border-kumo-line p-3"
                >
                  <div className="mt-0.5">
                    <StepIcon status={step.status} />
                  </div>
                  <div className="flex flex-1 flex-col gap-1">
                    <Text variant="body">{step.name}</Text>
                    {step.result && (
                      <Text variant="secondary">{step.result}</Text>
                    )}
                    {step.status === "skipped" && (
                      <Text variant="secondary">
                        <em>Restored from checkpoint</em>
                      </Text>
                    )}
                  </div>
                  <StepBadge status={step.status} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Eviction Demo */}
        {isRunning && (
          <div className="rounded-lg border border-kumo-line p-4">
            <Text variant="heading3">Simulate Eviction</Text>
            <p className="mt-1 text-sm text-kumo-inactive">
              In production, Durable Objects can be evicted by code updates or
              inactivity. This simulates that — the fiber state persists in
              SQLite, and recovery picks up from the last checkpoint.
            </p>
            <div className="mt-3">
              <Button variant="secondary" onClick={handleKillAndRecover}>
                Simulate Kill &amp; Recover
              </Button>
            </div>
          </div>
        )}

        {/* Recovery banner */}
        {status === "recovered" && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
            <Text variant="success">
              Fiber recovered from checkpoint. Skipping already-completed
              steps...
            </Text>
          </div>
        )}

        {/* Completion */}
        {status === "complete" && results.length > 0 && (
          <div className="rounded-lg border border-kumo-line p-4">
            <Text variant="heading3">Research Complete</Text>
            <div className="mt-3 flex flex-col gap-2">
              {results.map((r, i) => (
                <div key={i} className="rounded-md border border-kumo-line p-3">
                  <Text variant="body">{r.name}</Text>
                  <Text variant="secondary">{r.result}</Text>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setSteps([]);
                  setResults([]);
                  setStatus("idle");
                  setFiberId(null);
                }}
              >
                Start New Research
              </Button>
            </div>
          </div>
        )}

        {/* Cancelled */}
        {status === "cancelled" && (
          <div className="rounded-lg border border-kumo-line p-4">
            <Text variant="body">Research cancelled.</Text>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setSteps([]);
                  setStatus("idle");
                  setFiberId(null);
                }}
              >
                Start New Research
              </Button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="flex items-center justify-center border-t border-kumo-line p-4">
        <PoweredByAgents />
      </footer>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "complete":
    case "skipped":
      return <span className="text-green-500">&#10003;</span>;
    case "running":
      return <span className="animate-spin text-blue-500">&#9696;</span>;
    default:
      return <span className="text-kumo-inactive">&#9675;</span>;
  }
}

function StepBadge({ status }: { status: StepStatus }) {
  const variant: React.ComponentProps<typeof Badge>["variant"] =
    status === "complete"
      ? "outline"
      : status === "running"
        ? "primary"
        : status === "skipped"
          ? "beta"
          : "secondary";

  return <Badge variant={variant}>{status}</Badge>;
}
