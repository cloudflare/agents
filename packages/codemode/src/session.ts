/**
 * CodemodeSession — generic DurableObject facet for pending action storage.
 *
 * One session per connector, spawned as a facet of the agent DO.
 * Stores pending actions in ctx.storage — survives hibernation.
 *
 * The session is a pure state store. Approval checks and tool dispatch
 * happen in the proxy tool's binding wrapper, not here. This avoids
 * storing non-serializable connector references that would break on
 * DO hibernation.
 */
import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingAction = {
  id: string;
  connector: string;
  method: string;
  args: unknown;
  description?: string;
  provisionalResult: unknown;
  createdAt: number;
};

export type ActionResult = {
  result: unknown;
  pending?: PendingAction;
};

// ---------------------------------------------------------------------------
// Session — pure state store
// ---------------------------------------------------------------------------

export class CodemodeSession extends DurableObject {
  async storePendingAction(action: PendingAction): Promise<void> {
    this.ctx.storage.put(`pending:${action.id}`, action);
  }

  async getPendingAction(id: string): Promise<PendingAction | null> {
    return (await this.ctx.storage.get<PendingAction>(`pending:${id}`)) ?? null;
  }

  async deletePendingAction(id: string): Promise<void> {
    this.ctx.storage.delete(`pending:${id}`);
  }

  async listPendingActions(): Promise<PendingAction[]> {
    const entries = await this.ctx.storage.list<PendingAction>({
      prefix: "pending:"
    });
    return [...entries.values()];
  }
}
