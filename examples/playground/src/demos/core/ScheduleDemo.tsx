import { useAgent } from "agents/react";
import type { Schedule } from "agents";
import { useState, useEffect } from "react";
import { Button, Input, Surface } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { ScheduleAgent, ScheduleAgentState } from "./schedule-agent";

export function ScheduleDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [delaySeconds, setDelaySeconds] = useState("5");
  const [message, setMessage] = useState("Hello from schedule!");
  const [intervalSeconds, setIntervalSeconds] = useState("10");
  const [intervalLabel, setIntervalLabel] = useState("Recurring ping");

  const agent = useAgent<ScheduleAgent, ScheduleAgentState>({
    agent: "schedule-agent",
    name: "schedule-demo",
    onOpen: () => {
      addLog("info", "connected");
      refreshSchedules();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data as string);
        if (data.type === "schedule_executed") {
          addLog("in", "schedule_executed", data.payload);
          refreshSchedules();
        } else if (data.type === "recurring_executed") {
          addLog("in", "recurring_executed", data.payload);
        }
      } catch {
        // Not JSON or not our message type
      }
    }
  });

  const refreshSchedules = async () => {
    try {
      const result = await agent.call("listSchedules");
      setSchedules(result);
    } catch {
      // Ignore errors during refresh
    }
  };

  useEffect(() => {
    if (agent.readyState === WebSocket.OPEN) {
      refreshSchedules();
    }
  }, [agent.readyState]);

  const handleScheduleTask = async () => {
    addLog("out", "scheduleTask", {
      delaySeconds: Number(delaySeconds),
      message
    });
    try {
      const id = await agent.call("scheduleTask", [
        Number(delaySeconds),
        message
      ]);
      addLog("in", "scheduled", { id });
      refreshSchedules();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleScheduleRecurring = async () => {
    addLog("out", "scheduleRecurring", {
      intervalSeconds: Number(intervalSeconds),
      label: intervalLabel
    });
    try {
      const id = await agent.call("scheduleRecurring", [
        Number(intervalSeconds),
        intervalLabel
      ]);
      addLog("in", "scheduled", { id });
      refreshSchedules();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleCancel = async (id: string) => {
    addLog("out", "cancelTask", { id });
    try {
      const result = await agent.call("cancelTask", [id]);
      addLog("in", "cancelled", { id, success: result });
      refreshSchedules();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  };

  return (
    <DemoWrapper
      title="Scheduling"
      description="Schedule one-time tasks, recurring intervals, and cron-based jobs. Schedules persist across restarts."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-kumo-default">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
          </Surface>

          {/* One-time Task */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <h3 className="font-semibold text-kumo-default mb-4">
              One-time Task
            </h3>
            <p className="text-sm text-kumo-subtle mb-3">
              Schedule a task to run after a delay
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={delaySeconds}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setDelaySeconds(e.target.value)
                  }
                  className="w-20"
                  min={1}
                />
                <span className="text-sm text-kumo-subtle self-center">
                  seconds
                </span>
              </div>
              <Input
                type="text"
                value={message}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setMessage(e.target.value)
                }
                className="w-full"
                placeholder="Message"
              />
              <Button
                variant="primary"
                onClick={handleScheduleTask}
                className="w-full"
              >
                Schedule Task
              </Button>
            </div>
          </Surface>

          {/* Recurring Task */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <h3 className="font-semibold text-kumo-default mb-4">
              Recurring Task
            </h3>
            <p className="text-sm text-kumo-subtle mb-3">
              Schedule a task to repeat at an interval
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={intervalSeconds}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setIntervalSeconds(e.target.value)
                  }
                  className="w-20"
                  min={5}
                />
                <span className="text-sm text-kumo-subtle self-center">
                  second interval
                </span>
              </div>
              <Input
                type="text"
                value={intervalLabel}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setIntervalLabel(e.target.value)
                }
                className="w-full"
                placeholder="Label"
              />
              <Button
                variant="primary"
                onClick={handleScheduleRecurring}
                className="w-full"
              >
                Schedule Recurring
              </Button>
            </div>
          </Surface>

          {/* Active Schedules */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-kumo-default">
                Active Schedules ({schedules.length})
              </h3>
              <Button variant="ghost" size="xs" onClick={refreshSchedules}>
                Refresh
              </Button>
            </div>
            {schedules.length === 0 ? (
              <p className="text-sm text-kumo-inactive">No active schedules</p>
            ) : (
              <div className="space-y-2">
                {schedules.map((schedule) => (
                  <div
                    key={schedule.id}
                    className="flex items-center justify-between py-2 px-3 bg-kumo-elevated rounded text-sm"
                  >
                    <div>
                      <div className="font-medium text-kumo-default">
                        {schedule.callback}
                      </div>
                      <div className="text-xs text-kumo-subtle">
                        {schedule.type === "interval"
                          ? `Every ${schedule.intervalSeconds}s`
                          : schedule.time
                            ? `At ${formatTime(schedule.time)}`
                            : schedule.type}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCancel(schedule.id)}
                      className="text-xs text-kumo-danger hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Surface>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
