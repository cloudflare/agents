import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { RetryAgent, RetryAgentState } from "./retry-agent";

export function RetryDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [succeedOn, setSucceedOn] = useState("3");
  const [failCount, setFailCount] = useState("2");
  const [permanent, setPermanent] = useState(false);
  const [queueAttempts, setQueueAttempts] = useState("3");

  const agent = useAgent<RetryAgent, RetryAgentState>({
    agent: "retry-agent",
    name: "retry-demo",
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data as string);
        if (data.type === "log" && data.entry) {
          const entry = data.entry;
          const logType =
            entry.type === "success"
              ? "in"
              : entry.type === "failure"
                ? "error"
                : entry.type === "attempt"
                  ? "out"
                  : "info";
          addLog(logType, entry.type, entry.message);
        }
      } catch {
        // Not JSON
      }
    }
  });

  const handleRetryFlaky = async () => {
    addLog("out", "retryFlaky", { succeedOnAttempt: Number(succeedOn) });
    try {
      const result = await agent.call("retryFlaky", [Number(succeedOn)]);
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleRetryWithFilter = async () => {
    addLog("out", "retryWithFilter", {
      failCount: Number(failCount),
      permanent
    });
    try {
      const result = await agent.call("retryWithFilter", [
        Number(failCount),
        permanent
      ]);
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleQueueRetry = async () => {
    addLog("out", "queueWithRetry", {
      maxAttempts: Number(queueAttempts)
    });
    try {
      const id = await agent.call("queueWithRetry", [Number(queueAttempts)]);
      addLog("in", "queued", { id });
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleClear = async () => {
    clearLogs();
    try {
      await agent.call("clearLog", []);
    } catch {
      // ignore
    }
  };

  return (
    <DemoWrapper
      title="Retries"
      description="Retry operations with exponential backoff, selective retry via shouldRetry, and queue retry options."
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
          {/* this.retry() — Flaky Operation */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">this.retry() — Flaky Operation</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Simulates a flaky operation that succeeds on the Nth attempt. Uses
              class-level defaults (4 max attempts).
            </p>
            <div className="space-y-2">
              <div className="flex gap-2 items-center">
                <span className="text-sm text-kumo-subtle">
                  Succeed on attempt
                </span>
                <Input
                  aria-label="Succeed on attempt number"
                  type="number"
                  value={succeedOn}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setSucceedOn(e.target.value)
                  }
                  className="w-20"
                  min={1}
                  max={10}
                />
              </div>
              <Button
                variant="primary"
                onClick={handleRetryFlaky}
                className="w-full"
              >
                Run Flaky Operation
              </Button>
            </div>
          </Surface>

          {/* shouldRetry — Selective Retry */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">shouldRetry — Selective Retry</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Uses shouldRetry to bail early on permanent errors. Transient
              errors are retried; permanent errors stop immediately.
            </p>
            <div className="space-y-2">
              <div className="flex gap-2 items-center">
                <span className="text-sm text-kumo-subtle">
                  Failures before success
                </span>
                <Input
                  aria-label="Number of failures"
                  type="number"
                  value={failCount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFailCount(e.target.value)
                  }
                  className="w-20"
                  min={1}
                  max={9}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-kumo-subtle cursor-pointer">
                <input
                  type="checkbox"
                  checked={permanent}
                  onChange={(e) => setPermanent(e.target.checked)}
                />
                Permanent error (shouldRetry returns false)
              </label>
              <Button
                variant="primary"
                onClick={handleRetryWithFilter}
                className="w-full"
              >
                Run Filtered Retry
              </Button>
            </div>
          </Surface>

          {/* Queue with Retry */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Queue with Retry</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Queues a task that fails until the last retry attempt, then
              succeeds.
            </p>
            <div className="space-y-2">
              <div className="flex gap-2 items-center">
                <span className="text-sm text-kumo-subtle">Max attempts</span>
                <Input
                  aria-label="Max retry attempts"
                  type="number"
                  value={queueAttempts}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setQueueAttempts(e.target.value)
                  }
                  className="w-20"
                  min={1}
                  max={10}
                />
              </div>
              <Button
                variant="primary"
                onClick={handleQueueRetry}
                className="w-full"
              >
                Queue Task
              </Button>
            </div>
          </Surface>

          {/* Clear */}
          <Button variant="ghost" onClick={handleClear} className="w-full">
            Clear Logs
          </Button>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={handleClear} maxHeight="500px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
