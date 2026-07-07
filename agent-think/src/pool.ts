/**
 * Tiny client helper for talking to the WarmPool Durable Object.
 *
 * Every request reconfigures the pool from current env vars
 * (idempotent) and asks it to resolve the caller's session id into
 * a Sandbox DO name. The name then drives
 * `env.Sandbox.idFromName(...)` to fetch the actual DO stub.
 *
 * The pool was originally written against the `@cloudflare/sandbox`
 * SDK and called these IDs "container UUIDs". Same concept, same
 * representation — we just feed them into the new Sandbox DO instead
 * of the old SDK's `getSandbox()`.
 */

import type { WarmPool, WarmPoolConfig } from "./warm-pool";
import type { Sandbox } from "./sandbox";

export interface PoolEnv {
  WarmPool: DurableObjectNamespace<WarmPool>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  WARM_POOL_TARGET?: string;
  WARM_POOL_REFRESH_INTERVAL?: string;
  WARM_POOL_ASSIGNMENT_IDLE_TTL_MS?: string;
}

function readConfig(env: PoolEnv): Required<WarmPoolConfig> {
  return {
    warmTarget: Number.parseInt(env.WARM_POOL_TARGET ?? "0", 10) || 0,
    refreshInterval:
      Number.parseInt(env.WARM_POOL_REFRESH_INTERVAL ?? "10000", 10) || 10_000,
    // Default 1 hour; set the wrangler var to 0 to disable idle eviction
    // (e.g. during a debugging session where you want sticky assignments).
    assignmentIdleTtl:
      Number.parseInt(env.WARM_POOL_ASSIGNMENT_IDLE_TTL_MS ?? "3600000", 10) ||
      0
  };
}

function poolStub(env: PoolEnv) {
  const id = env.WarmPool.idFromName("global-pool");
  return env.WarmPool.get(id);
}

/**
 * Resolve a session id to a container UUID. Pushes the latest config to
 * the pool every call so wrangler-var changes take effect on deploy.
 */
export async function resolveContainerId(
  env: PoolEnv,
  sessionId: string
): Promise<string> {
  const stub = poolStub(env);
  await stub.configure(readConfig(env));
  return stub.getContainer(sessionId);
}

/** Allocate/touch a container and protect it while a durable run is active. */
export async function beginContainerActivity(
  env: PoolEnv,
  sessionId: string,
  leaseId: string,
  leaseMs: number
): Promise<void> {
  await resolveContainerId(env, sessionId);
  await poolStub(env).beginActivity(sessionId, leaseId, leaseMs);
}

/** Renew a live run lease without reconnecting Workspace. */
export async function renewContainerActivity(
  env: PoolEnv,
  sessionId: string,
  leaseId: string,
  leaseMs: number
): Promise<boolean> {
  return poolStub(env).renewActivity(sessionId, leaseId, leaseMs);
}

/** End a live run lease; the sticky assignment remains until normal idle eviction. */
export async function endContainerActivity(
  env: PoolEnv,
  sessionId: string,
  leaseId: string
): Promise<boolean> {
  return poolStub(env).endActivity(sessionId, leaseId);
}

/**
 * Explicitly release a session's container assignment. Called when an
 * agent thread is reset or deleted so the quota slot is freed
 * immediately rather than waiting for the idle-eviction sweep. Best-
 * effort: errors are swallowed so a teardown can't fail because of a
 * pool RPC blip.
 */
export async function releaseContainer(
  env: PoolEnv,
  sessionId: string
): Promise<void> {
  try {
    await poolStub(env).releaseAssignment(sessionId);
  } catch (err) {
    console.warn("[pool] releaseAssignment failed", { sessionId, err });
  }
}

/** Prime the pool — kicks off its alarm loop. Called from `scheduled()`. */
export async function primePool(env: PoolEnv): Promise<void> {
  await poolStub(env).configure(readConfig(env));
}

/** Pool stats, for debug endpoints. */
export async function poolStats(env: PoolEnv) {
  return poolStub(env).getStats();
}
