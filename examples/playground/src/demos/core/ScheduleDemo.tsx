import { useAgent } from "agents/react";
import type { Schedule } from "agents";
import { useState, useEffect } from "react";
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

          {/* One-time Task */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">One-time Task</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Schedule a task to run after a delay
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="number"
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(e.target.value)}
                  className="input w-20"
                  min="1"
                />
                <span className="text-sm text-neutral-500 self-center">
                  seconds
                </span>
              </div>
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="input w-full"
                placeholder="Message"
              />
              <button
                type="button"
                onClick={handleScheduleTask}
                className="btn btn-primary w-full"
              >
                Schedule Task
              </button>
            </div>
          </div>

          {/* Recurring Task */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Recurring Task</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Schedule a task to repeat at an interval
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="number"
                  value={intervalSeconds}
                  onChange={(e) => setIntervalSeconds(e.target.value)}
                  className="input w-20"
                  min="5"
                />
                <span className="text-sm text-neutral-500 self-center">
                  second interval
                </span>
              </div>
              <input
                type="text"
                value={intervalLabel}
                onChange={(e) => setIntervalLabel(e.target.value)}
                className="input w-full"
                placeholder="Label"
              />
              <button
                type="button"
                onClick={handleScheduleRecurring}
                className="btn btn-primary w-full"
              >
                Schedule Recurring
              </button>
            </div>
          </div>

          {/* Active Schedules */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">
                Active Schedules ({schedules.length})
              </h3>
              <button
                type="button"
                onClick={refreshSchedules}
                className="text-xs text-neutral-500 hover:text-black"
              >
                Refresh
              </button>
            </div>
            {schedules.length === 0 ? (
              <p className="text-sm text-neutral-400">No active schedules</p>
            ) : (
              <div className="space-y-2">
                {schedules.map((schedule) => (
                  <div
                    key={schedule.id}
                    className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-800 rounded text-sm"
                  >
                    <div>
                      <div className="font-medium">{schedule.callback}</div>
                      <div className="text-xs text-neutral-500">
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
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
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
