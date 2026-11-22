import { DurableObject } from "cloudflare:workers";
import {
  Approvals,
  type ApprovalsRetention,
  type Decision
} from "../../approvals";
import { Lifecycle } from "../../lifecycle";

/**
 * Minimal real host for capability-level Approvals tests: a Durable Object
 * whose only capability is Approvals, with runtime handlers installed so
 * tests drive real startup, real SQLite and real alarms.
 *
 * The continuation runs its side effect through `once()`, keyed by the
 * decision id, the way a host is meant to: `sideEffects` counts real runs,
 * so a test can tell a rerun after a reset from a replay.
 */
export class ApprovalsHarnessObject extends DurableObject<Cloudflare.Env> {
  /** Every continuation call, in order. */
  readonly continued: string[] = [];
  /** Every hand-off, in order. */
  readonly handedOff: Array<{ id: string; redelivered: boolean }> = [];
  /** Real side-effect runs. */
  sideEffects = 0;
  /** Continuation calls that throw before succeeding. */
  failuresBeforeSuccess = 0;
  /** Whether the hand-off acknowledges the outcome. */
  acknowledgeOnSettle = true;
  retention: ApprovalsRetention = {};
  #gate: Promise<void> | null = null;
  #release: (() => void) | null = null;

  readonly approvals: Approvals = new Approvals({
    onDecided: async (decision: Decision): Promise<unknown> => {
      this.continued.push(decision.id);
      await this.#gate;
      if (this.failuresBeforeSuccess > 0) {
        this.failuresBeforeSuccess -= 1;
        throw new Error("continuation failed");
      }
      if (!decision.verdict?.approved) {
        return { status: "rejected", reason: decision.verdict?.reason };
      }
      const effect = await this.approvals.once({
        key: `effect:${decision.id}`,
        name: "send",
        input: decision.subject,
        run: () => {
          this.sideEffects += 1;
          return { sent: true };
        }
      });
      return { status: "done", effect: effect.status };
    },
    onSettled: (decision, delivery) => {
      this.handedOff.push({
        id: decision.id,
        redelivered: delivery.redelivered
      });
      if (this.acknowledgeOnSettle) this.approvals.acknowledge(decision.id);
    },
    retention: () => this.retention,
    // Far enough out that a test's own alarm run decides when it fires.
    resumeAfterMs: 60 * 60 * 1000
  });

  readonly lifecycle = Lifecycle.install(this).use(this.approvals);

  /** Hold every continuation until {@link release}. */
  hold(): void {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#gate = null;
    this.#release = null;
  }
}

/** Make the recovery job of decision `id` due now. */
export function backdateDecisionJob(
  storage: DurableObjectStorage,
  id: string
): void {
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE id = ? AND capability = 'approvals'",
    Date.now() - 1000,
    `decision:${id}`
  );
}
