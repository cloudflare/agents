import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { WebSockets } from "../../websockets";

/**
 * A plain Durable Object whose WebSockets capability opted out of the
 * connection heartbeat (`heartbeat: false`), and whose message handler
 * answers nothing. A client heartbeat therefore never gets a `pong`:
 * the socket stays open on the wire while the client's pong timeout
 * runs out, which is exactly the shape of a silently dropped socket.
 *
 * Every frame the host sees is recorded, so a test can prove the `ping`
 * reached `onMessage` as an ordinary message on an opted-out host.
 */
export class HeartbeatSilentObject extends DurableObject<Cloudflare.Env> {
  readonly #received: string[] = [];
  readonly #webSockets = new WebSockets({
    heartbeat: false,
    handlers: {
      onMessage: (_connection, message) => {
        this.#received.push(String(message));
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.#webSockets);

  /** Frames the host's `onMessage` saw, in order. */
  async receivedFrames(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return this.#received;
  }

  /** Open connections, so a test can watch a reconnect land. */
  async connectionCount(): Promise<number> {
    await this.lifecycle.start();
    return [...this.#webSockets.getConnections()].length;
  }
}
