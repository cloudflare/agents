import type { Sandbox } from "./sandbox";
import type { WarmPool } from "./warm-pool";

export interface PoolEnv {
  WarmPool: DurableObjectNamespace<WarmPool>;
  Sandbox: DurableObjectNamespace<Sandbox>;
}

function pool(env: PoolEnv) {
  return env.WarmPool.get(env.WarmPool.idFromName("global-pool"));
}

/** Claim one warm container for this agent turn. */
export function resolveContainerId(
  env: PoolEnv,
  sessionId: string
): Promise<string> {
  return pool(env).claimContainer(sessionId);
}

/** Stop and drop this turn's claimed container, then restore the warm slot. */
export async function releaseContainer(
  env: PoolEnv,
  sessionId: string
): Promise<void> {
  try {
    await pool(env).releaseAssignment(sessionId);
  } catch (error) {
    console.warn("[pool] releaseAssignment failed", { sessionId, error });
  }
}

/** Ensure the single warm slot is populated. Called from cron. */
export function primePool(env: PoolEnv): Promise<void> {
  return pool(env).ensureWarm();
}

/** Pool stats for local diagnostics and tests. */
export function poolStats(env: PoolEnv) {
  return pool(env).getStats();
}
