import { DurableObject } from "cloudflare:workers";
import { Approvals, type Decision } from "../../approvals";
import { Lifecycle } from "../../lifecycle";

/** Approvals harness whose continuation and hand-off a test swaps per case. */
export class ApprovalsReviewObject extends DurableObject<Cloudflare.Env> {
  decided: (decision: Decision) => Promise<unknown> = async () => "ok";
  settled: (decision: Decision) => Promise<void> = async (d) => {
    this.approvals.acknowledge(d.id);
  };
  readonly approvals: Approvals = new Approvals({
    onDecided: (d) => this.decided(d),
    onSettled: (d) => this.settled(d),
    resumeAfterMs: 60 * 60 * 1000
  });
  readonly lifecycle = Lifecycle.install(this).use(this.approvals);
}
