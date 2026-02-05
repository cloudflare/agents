import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Props passed to the EchoLoopback via ctx.exports
 */
export interface EchoLoopbackProps {
  sessionId: string;
}

/**
 * EchoLoopback - A simple test loopback for verifying the pattern works
 *
 * This is a minimal example of the loopback pattern. It demonstrates:
 * - How props are passed from the parent Agent
 * - How methods are called from dynamic workers
 * - How responses flow back
 *
 * Usage from dynamic worker:
 *   const response = await env.ECHO.ping("hello");
 *   console.log(response); // "hello"
 */
export class EchoLoopback extends WorkerEntrypoint<Env, EchoLoopbackProps> {
  /**
   * Simply echo back the input
   */
  async ping(message: string): Promise<string> {
    return message;
  }

  /**
   * Return information about this loopback session
   */
  async info(): Promise<{ sessionId: string; timestamp: number }> {
    return {
      sessionId: this.ctx.props.sessionId,
      timestamp: Date.now()
    };
  }

  /**
   * Echo with metadata
   */
  async echo(data: unknown): Promise<{ data: unknown; sessionId: string }> {
    return {
      data,
      sessionId: this.ctx.props.sessionId
    };
  }
}
