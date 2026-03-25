import { Agent, callable, routeAgentRequest } from "agents";
import webpush from "web-push";

type Subscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type Reminder = {
  id: string;
  message: string;
  scheduledAt: number;
  sent: boolean;
};

export type ReminderAgentState = {
  subscriptions: Subscription[];
  reminders: Reminder[];
};

export class ReminderAgent extends Agent<Env, ReminderAgentState> {
  initialState: ReminderAgentState = {
    subscriptions: [],
    reminders: []
  };

  @callable()
  getVapidPublicKey(): string {
    return this.env.VAPID_PUBLIC_KEY;
  }

  @callable()
  async subscribe(subscription: Subscription): Promise<{ ok: boolean }> {
    const exists = this.state.subscriptions.some(
      (s) => s.endpoint === subscription.endpoint
    );
    if (!exists) {
      this.setState({
        ...this.state,
        subscriptions: [...this.state.subscriptions, subscription]
      });
    }
    return { ok: true };
  }

  @callable()
  async unsubscribe(endpoint: string): Promise<{ ok: boolean }> {
    this.setState({
      ...this.state,
      subscriptions: this.state.subscriptions.filter(
        (s) => s.endpoint !== endpoint
      )
    });
    return { ok: true };
  }

  @callable()
  async createReminder(
    message: string,
    delaySeconds: number
  ): Promise<Reminder> {
    const id = crypto.randomUUID();
    const scheduledAt = Date.now() + delaySeconds * 1000;

    const reminder: Reminder = { id, message, scheduledAt, sent: false };

    this.setState({
      ...this.state,
      reminders: [...this.state.reminders, reminder]
    });

    await this.schedule(delaySeconds, "sendReminder", { id, message });

    return reminder;
  }

  @callable()
  async cancelReminder(id: string): Promise<{ ok: boolean }> {
    const schedules = this.getSchedules();
    for (const schedule of schedules) {
      const payload = schedule.payload as unknown as
        | Record<string, unknown>
        | undefined;
      if (payload?.id === id) {
        await this.cancelSchedule(schedule.id);
        break;
      }
    }

    this.setState({
      ...this.state,
      reminders: this.state.reminders.filter((r) => r.id !== id)
    });

    return { ok: true };
  }

  @callable()
  async sendTestNotification(): Promise<{ sent: number; failed: number }> {
    return this.pushToAll({
      title: "Test Notification",
      body: "Push notifications are working!",
      tag: "test"
    });
  }

  async sendReminder(payload: { id: string; message: string }) {
    await this.pushToAll({
      title: "Reminder",
      body: payload.message,
      tag: `reminder-${payload.id}`
    });

    this.setState({
      ...this.state,
      reminders: this.state.reminders.map((r) =>
        r.id === payload.id ? { ...r, sent: true } : r
      )
    });

    this.broadcast(
      JSON.stringify({
        type: "reminder_sent",
        id: payload.id,
        timestamp: Date.now()
      })
    );
  }

  private async pushToAll(
    notification: Record<string, unknown>
  ): Promise<{ sent: number; failed: number }> {
    webpush.setVapidDetails(
      this.env.VAPID_SUBJECT || "mailto:test@example.com",
      this.env.VAPID_PUBLIC_KEY,
      this.env.VAPID_PRIVATE_KEY
    );

    const deadEndpoints: string[] = [];
    let sent = 0;
    let failed = 0;

    await Promise.all(
      this.state.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, JSON.stringify(notification));
          sent++;
        } catch (err: unknown) {
          const statusCode =
            err instanceof webpush.WebPushError ? err.statusCode : 0;
          if (statusCode === 404 || statusCode === 410) {
            deadEndpoints.push(sub.endpoint);
          }
          failed++;
        }
      })
    );

    if (deadEndpoints.length > 0) {
      this.setState({
        ...this.state,
        subscriptions: this.state.subscriptions.filter(
          (s) => !deadEndpoints.includes(s.endpoint)
        )
      });
    }

    return { sent, failed };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
