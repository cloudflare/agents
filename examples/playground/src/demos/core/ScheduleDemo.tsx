import { useAgent } from "agents/react";
import type { Schedule } from "agents";
import { useState, useEffect, useCallback } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type { ScheduleAgent, ScheduleAgentState } from "./schedule-agent";

const codeSections: CodeSection[] = [
  {
    title: "Schedule tasks from within an agent",
    description:
      "Use this.schedule() to fire a callback after a delay. The schedule is durable — if the Worker hibernates and wakes up, pending schedules still execute.",
    code: `import { Agent, callable } from "agents";

class ScheduleAgent extends Agent<Env> {
  @callable()
  async scheduleTask(delaySeconds: number, message: string) {
    const schedule = await this.schedule(
      delaySeconds,
      "onScheduledTask",
      { message }
    );
    return schedule.id;
  }

  async onScheduledTask(payload: { message: string }) {
    console.log("Executed:", payload.message);
    this.broadcast(JSON.stringify({
      type: "schedule_executed",
      payload,
    }));
  }
}`
  },
  {
    title: "Recurring intervals",
    description:
      "Pass a callback name and payload — the agent will keep invoking it at the given interval. Use this.cancelSchedule(id) to stop it.",
    code: `  @callable()
  async scheduleRecurring(intervalSeconds: number, label: string) {
    const schedule = await this.schedule(
      intervalSeconds,
      "onRecurringTask",
      { label, recurring: true }
    );
    return schedule.id;
  }

  @callable()
  async cancelTask(id: string) {
    return await this.cancelSchedule(id);
  }

  @callable()
  listSchedules() {
    return this.getSchedules();
  }`
  },
  {
    title: "React to schedule events on the client",
    description:
      "The agent broadcasts messages when schedules fire. Listen for them with the onMessage callback in useAgent.",
    code: `const agent = useAgent({
  agent: "schedule-agent",
  name: "my-instance",
  onMessage: (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "schedule_executed") {
      // a one-time schedule just fired
    } else if (data.type === "recurring_executed") {
      // an interval tick
    }
  },
});

// schedule a task from the client
const id = await agent.call("scheduleTask", [10, "hello"]);

// cancel it later
await agent.call("cancelTask", [id]);`
  }
];

export function ScheduleDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [delaySeconds, setDelaySeconds] = useState("5");
  const [message, setMessage] = useState("Hello from schedule!");
  const [intervalSeconds, setIntervalSeconds] = useState("10");
  const [intervalLabel, setIntervalLabel] = useState("Recurring ping");

  const agent = useAgent<ScheduleAgent, ScheduleAgentState>({
    agent: "schedule-agent",
    name: `schedule-demo-${userId}`,
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

  const refreshSchedules = useCallback(async () => {
    try {
      const result = await agent.call("listSchedules");
      setSchedules(result);
    } catch {
      // Ignore errors during refresh
    }
  }, [agent]);

  useEffect(() => {
    if (agent.readyState === WebSocket.OPEN) {
      refreshSchedules();
    }
  }, [agent.readyState, refreshSchedules]);

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
      description={
        <>
          Agents can schedule work for the future using{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.schedule()
          </code>
          . Schedule a one-time task with a delay in seconds, or set up a
          recurring interval that fires repeatedly. Schedules are durable — they
          persist across Worker restarts and hibernation, so a task scheduled
          for an hour from now will still fire even if the Durable Object sleeps
          in between. Try scheduling a 5-second task and watch the event log.
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
          {/* One-time Task */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">One-time Task</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Schedule a task to run after a delay
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  aria-label="Delay in seconds"
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
                aria-label="Task message"
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
            <div className="mb-4">
              <Text variant="heading3">Recurring Task</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Schedule a task to repeat at an interval
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  aria-label="Interval in seconds"
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
                aria-label="Recurring task label"
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
              <Text variant="heading3">
                Active Schedules ({schedules.length})
              </Text>
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
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => handleCancel(schedule.id)}
                      className="text-kumo-danger"
                    >
                      Cancel
                    </Button>
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

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
