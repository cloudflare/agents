import { LifecycleCapability } from "../lifecycle/capability";
import type {
  CapabilityRequestContext,
  CapabilityWebSocketUpgradeContext
} from "../lifecycle/capability-runner";
import { forwardAgentToolRunRequest } from "./child";

/**
 * Forwards `/agent-tool-runs/{runId}/...` under a parent to the child of
 * that run, so a client drills in through the parent and reaches only the
 * runs the parent started. After an upgrade the child owns the socket.
 *
 * Install before any capability that claims every WebSocket upgrade.
 */
export class AgentToolRunRoute extends LifecycleCapability {
  readonly #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    super("agent-tool-run-route");
    this.#ctx = ctx;
  }

  onRequest({
    request
  }: CapabilityRequestContext): Promise<Response | undefined> {
    return this.#forward(request);
  }

  onWebSocketUpgrade({
    request
  }: CapabilityWebSocketUpgradeContext): Promise<Response | undefined> {
    return this.#forward(request);
  }

  #forward(request: Request): Promise<Response | undefined> {
    return forwardAgentToolRunRequest(this.#ctx, request, (runId) =>
      this.#child(runId)
    );
  }

  #child(runId: string): { className: string; childName: string } | null {
    try {
      const [row] = this.lifecycle.storage.sql
        .exec<{ agent_type: string; child_name: string | null }>(
          "SELECT agent_type, child_name FROM cf_agent_tool_runs WHERE run_id = ?",
          runId
        )
        .toArray();
      return row?.child_name
        ? { className: row.agent_type, childName: row.child_name }
        : null;
    } catch {
      // No run table yet: this agent has started no runs.
      return null;
    }
  }
}
