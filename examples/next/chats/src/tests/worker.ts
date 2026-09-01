// Test worker: re-export the production classes. Must not import
// cloudflare:test — vitest boots this module graph via wrangler.
import { ChatAgent, UserAgent } from "../index";

export { ChatAgent, UserAgent };
export { default } from "../index";

/** User index with a durable failure switch for projection-delivery tests. */
export class TestUserAgent extends UserAgent {
  override onStart(): void {
    super.onStart();
    this.sql`
      CREATE TABLE IF NOT EXISTS projection_test_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        blocked INTEGER NOT NULL
      )
    `;
    this.sql`
      INSERT OR IGNORE INTO projection_test_state (id, blocked)
      VALUES (1, 0)
    `;
  }

  setProjectionDeliveryBlocked(blocked: boolean): void {
    this.sql`
      UPDATE projection_test_state SET blocked = ${blocked ? 1 : 0}
      WHERE id = 1
    `;
  }

  override applyChatSnapshot(
    snapshot: Parameters<UserAgent["applyChatSnapshot"]>[0]
  ): boolean {
    const [state] = this.sql<{ blocked: number }>`
      SELECT blocked FROM projection_test_state WHERE id = 1
    `;
    if (state?.blocked === 1) {
      throw new Error("Projection delivery blocked by test");
    }
    return super.applyChatSnapshot(snapshot);
  }
}
