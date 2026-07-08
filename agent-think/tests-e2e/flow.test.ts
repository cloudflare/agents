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

async function poolStats(): Promise<{ assigned: number }> {
  const response = await fetch(`${BASE_URL}/__test/pool-stats`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ assigned: number }>;
}

async function runPoolAlarm(): Promise<{ assigned: number }> {
  const response = await fetch(`${BASE_URL}/__test/pool-alarm`, {
    method: "POST"
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ assigned: number }>;
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
  it("syncs source files while keeping generated paths backend-local", async () => {
    const sync = await fetch(
      `${BASE_URL}/dev/workspace-sync/${crypto.randomUUID()}`
    );
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({
      hostFileVisibleInContainer: true,
      sourceFileDurable: true,
      generatedFileVisibleInContainer: true,
      generatedFileDurable: false,
      sourceFileRestoredAfterContainerReplacement: true,
      generatedFileRestoredAfterContainerReplacement: false
    });
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

  it("holds the lease during a real command, closes RPC streams, and reconnects", async () => {
    const issueNumber = issueBase + 1;
    const { session } = await dispatch(
      "TEST: hold active container lease",
      issueNumber
    );
    await vi.waitUntil(async () => (await poolStats()).assigned === 1, {
      timeout: 30_000,
      interval: 100
    });

    // TTL is one second; an explicit real alarm during the two-second command
    // must preserve the actively leased assignment.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await runPoolAlarm()).assigned).toBe(1);

    await waitForThread(session, "done");
    expect(transcriptText(await messages(session))).toContain("lifecycle-ok");

    // Once terminal cleanup ends the lease, the same alarm must evict it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await runPoolAlarm()).assigned).toBe(0);

    // The same durable agent session then reconnects to a fresh container.
    await dispatch("TEST: hold active container lease", issueNumber);
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
