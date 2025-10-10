import { env } from "cloudflare:test";
import type { Env } from "./worker";
import type { Persisted } from "../types";

/**
 * Helper to wait for async operations in Durable Objects
 */
export async function waitForProcessing(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to get agent stub by thread ID
 */
export function getAgentStub(threadId: string) {
  return env.AGENT_THREAD.get(env.AGENT_THREAD.idFromName(threadId));
}

/**
 * Helper to create a unique thread ID
 */
export function createThreadId(): string {
  return crypto.randomUUID();
}

/**
 * Common test headers for JSON requests
 */
export const JSON_HEADERS = {
  "content-type": "application/json"
};

/**
 * Helper to fetch thread state
 */
export async function fetchThreadState(
  worker: {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  },
  threadId: string,
  ctx: ExecutionContext
) {
  const req = new Request(`http://example.com/threads/${threadId}/state`, {
    method: "GET"
  });
  const res = await worker.fetch(req, env, ctx);
  return res.json<Persisted>();
}

/**
 * Helper to fetch thread events
 */
export async function fetchThreadEvents(
  worker: {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  },
  threadId: string,
  ctx: ExecutionContext
) {
  const req = new Request(`http://example.com/threads/${threadId}/events`, {
    method: "GET"
  });
  const res = await worker.fetch(req, env, ctx);
  return res.json();
}

/**
 * Helper to invoke a thread with messages
 */
export async function invokeThread(
  worker: {
    fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  },
  threadId: string,
  messages: Array<{ role: string; content: string }>,
  ctx: ExecutionContext,
  files?: Record<string, string>
) {
  const req = new Request(`http://example.com/threads/${threadId}/invoke`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ messages, files })
  });
  return worker.fetch(req, env, ctx);
}
