import { describe, expect, it, vi } from "vitest";
import { BASE_URL, wranglerOutput } from "./harness";

interface DebugMessage {
  role: string;
  parts: Array<{ type: string; text?: string; output?: unknown }>;
}

interface ThreadMeta {
  status: "running" | "done" | "error";
  lastError?: string;
}

const issueBase = 10_000 + Math.floor(Math.random() * 900_000);
let commentSequence = 1;

async function dispatch(instruction: string, issueNumber: number) {
  const response = await fetch(`${BASE_URL}/dev/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: "cloudflare/workers-oauth-provider",
      issueNumber,
      instruction,
      installationToken: "",
      commentId: issueNumber * 1000 + commentSequence++,
      issueTitle: "E2E lifecycle fixture",
      requestedBy: { login: "mattzcarey" }
    })
  });
  expect(response.status).toBe(202);
  return (await response.json()) as { session: string };
}

async function messages(session: string): Promise<DebugMessage[]> {
  const response = await fetch(
    `${BASE_URL}/dev/messages/${encodeURIComponent(session)}`
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<DebugMessage[]>;
}

interface PoolStats {
  warm: number;
  assigned: number;
  total: number;
  target: number;
}

async function poolStats(): Promise<PoolStats> {
  const response = await fetch(`${BASE_URL}/__test/pool-stats`);
  expect(response.status).toBe(200);
  return response.json() as Promise<PoolStats>;
}

async function runPoolAlarm(): Promise<PoolStats> {
  const response = await fetch(`${BASE_URL}/__test/pool-alarm`, {
    method: "POST"
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<PoolStats>;
}

async function thread(session: string): Promise<ThreadMeta | undefined> {
  const response = await fetch(`${BASE_URL}/api/command-center`);
  const state = (await response.json()) as {
    threads: Record<string, ThreadMeta>;
  };
  return state.threads[session];
}

async function waitForThread(
  session: string,
  status: ThreadMeta["status"]
): Promise<ThreadMeta> {
  let current: ThreadMeta | undefined;
  try {
    await vi.waitUntil(
      async () => {
        current = await thread(session);
        return current?.status === status;
      },
      { timeout: 60_000, interval: 200 }
    );
    return current as ThreadMeta;
  } catch (error) {
    const transcript = await messages(session).catch(() => []);
    throw new Error(
      `Timed out waiting for ${session}=${status}; current=${JSON.stringify(current)}\n` +
        `transcript=${JSON.stringify(transcript, null, 2)}\n` +
        `wrangler=${wranglerOutput().slice(-20_000)}`,
      { cause: error }
    );
  }
}

function transcriptText(items: DebugMessage[]): string {
  return items
    .flatMap((message) =>
      message.parts.flatMap((part) => [
        part.text ?? "",
        JSON.stringify(part.output)
      ])
    )
    .join("\n");
}

describe("E2E: production graph with inference adapter", () => {
  it("syncs Workspace VFS files while keeping /temp container-local", async () => {
    const sync = await fetch(
      `${BASE_URL}/dev/workspace-sync/${crypto.randomUUID()}`
    );
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({
      hostFileVisibleInContainer: true,
      sourceFileDurable: true,
      localTempFileDurable: false,
      sourceFileRestoredAfterContainerReplacement: true,
      localTempFileRestoredAfterContainerReplacement: false
    });
  }, 120_000);

  it("uses the lightweight VFS shell when backend is omitted", async () => {
    const { session } = await dispatch(
      "TEST: use default shell",
      issueBase + 3
    );
    await waitForThread(session, "done");
    expect(transcriptText(await messages(session))).toContain("shell-ok");
  }, 120_000);

  it("persists the immutable target even when skills register context", async () => {
    const issueNumber = issueBase;
    const { session } = await dispatch(
      "TEST: echo immutable run envelope",
      issueNumber
    );
    await waitForThread(session, "done");

    const text = transcriptText(await messages(session));
    expect(text).toContain("<agent-think-run>");
    expect(text).toContain(
      '\\"repository\\":\\"cloudflare/workers-oauth-provider\\"'
    );
    expect(text).toContain(`\\"issue\\":${issueNumber}`);
    expect(text).toContain('\\"requested-by\\":\\"@mattzcarey\\"');
    expect(text).toContain("captured-run-context:");
    expect(text).not.toContain("cloudflare/agents#1871");
  }, 120_000);

  it("claims a warm container for the turn and drops it at terminal", async () => {
    expect(await runPoolAlarm()).toMatchObject({
      warm: 1,
      assigned: 0,
      target: 1
    });

    const issueNumber = issueBase + 1;
    const { session } = await dispatch(
      "TEST: hold container turn",
      issueNumber
    );
    await vi.waitUntil(
      async () => {
        const stats = await poolStats();
        return stats.assigned === 1 && stats.warm === 1;
      },
      { timeout: 30_000, interval: 100 }
    );

    await waitForThread(session, "done");
    expect(transcriptText(await messages(session))).toContain("lifecycle-ok");
    await vi.waitUntil(
      async () => {
        const stats = await poolStats();
        return stats.assigned === 0 && stats.warm === 1;
      },
      { timeout: 30_000, interval: 100 }
    );

    // The same durable session claims a fresh container for its next turn.
    await dispatch("TEST: hold container turn", issueNumber);
    await waitForThread(session, "done");
    expect(transcriptText(await messages(session))).toContain("lifecycle-ok");
    expect(wranglerOutput()).not.toContain(
      "WritableStream RPC stub was disposed without calling close()"
    );
    expect(wranglerOutput()).not.toContain(
      "An RPC stub was not disposed properly"
    );
  }, 180_000);

  it("marks a tool-only step-budget exhaustion as error, not done", async () => {
    const { session } = await dispatch(
      "TEST: exhaust step budget",
      issueBase + 2
    );
    const terminal = await waitForThread(session, "error");
    expect(terminal.lastError).toContain("step safety limit after a tool call");
  }, 120_000);
});
