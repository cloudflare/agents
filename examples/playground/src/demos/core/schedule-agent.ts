import { callable, type Schedule } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface ScheduleAgentState {
  executedTasks: Array<{ id: string; message: string; timestamp: number }>;
}

export class ScheduleAgent extends Agent<Env, ScheduleAgentState> {
  initialState: ScheduleAgentState = {
    executedTasks: []
  };

  @callable({ description: "Schedule a one-time task" })
  async scheduleTask(delaySeconds: number, message: string): Promise<string> {
    const schedule = await this.schedule(delaySeconds, "onScheduledTask", {
      message
    });
    return schedule.id;
  }

  @callable({ description: "Schedule a recurring task" })
  async scheduleRecurring(
    intervalSeconds: number,
    label: string
  ): Promise<string> {
    const schedule = await this.schedule(intervalSeconds, "onRecurringTask", {
      label,
      recurring: true
    });
    return schedule.id;
  }

  @callable({ description: "Cancel a scheduled task" })
  async cancelTask(id: string): Promise<boolean> {
    return await this.cancelSchedule(id);
  }

  @callable({ description: "List all scheduled tasks" })
  listSchedules(): Schedule[] {
    return this.getSchedules();
  }

  async onScheduledTask(payload: { message: string }) {
    console.log(`Scheduled task executed: ${payload.message}`);
    this.broadcast(
      JSON.stringify({
        type: "schedule_executed",
        payload,
        timestamp: Date.now()
      })
    );
  }

  async onRecurringTask(payload: { label: string }) {
    console.log(`Recurring task: ${payload.label}`);
    this.broadcast(
      JSON.stringify({
        type: "recurring_executed",
        payload,
        timestamp: Date.now()
      })
    );
  }
}
