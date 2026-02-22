import { Agent, type Connection, type ConnectionContext } from "agents";

const IDLE_TIMEOUT_SECONDS = 15 * 60;
const IDLE_CALLBACK = "onIdleTimeout";

/**
 * Base class for all playground demo agents.
 *
 * Adds automatic self-cleanup: when all WebSocket connections close, a
 * 15-minute idle timer starts. If no one reconnects before it fires, the
 * agent calls this.destroy() to drop its SQLite tables and abort the
 * Durable Object — freeing resources from abandoned demo sessions.
 *
 * The timer is a durable schedule (persisted in SQLite), so it survives
 * hibernation. On reconnect we look it up by callback name via
 * getSchedules() and cancel it — no in-memory state needed.
 *
 * Agents that override onConnect/onClose must call super to preserve
 * this behavior (see ConnectionsAgent and RoomAgent).
 */
export class PlaygroundAgent<
  E extends Cloudflare.Env = Env,
  State = unknown
> extends Agent<E, State> {
  onConnect(_connection: Connection, _ctx: ConnectionContext) {
    for (const schedule of this.getSchedules()) {
      if (schedule.callback === IDLE_CALLBACK) {
        this.cancelSchedule(schedule.id);
      }
    }
  }

  onClose(_connection: Connection) {
    const remaining = [...this.getConnections()].length;
    if (remaining === 0) {
      this.schedule(IDLE_TIMEOUT_SECONDS, IDLE_CALLBACK, {});
    }
  }

  async onIdleTimeout() {
    const remaining = [...this.getConnections()].length;
    if (remaining === 0) {
      await this.destroy();
    }
  }
}
