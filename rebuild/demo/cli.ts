/**
 * Interactive terminal chat over the rebuilt Think agent — the whole system
 * running on the ports-and-adapters seams: a JSON-file KeyValueStore instead
 * of Durable Object storage, a setTimeout AlarmTimer instead of the DO alarm
 * slot, and this CLI acting as a transport adapter (subscribe to the
 * conversation event log, translate stdin lines into method calls).
 *
 * Run:   npm run demo               (real model if ANTHROPIC_API_KEY / an
 *                                    `ant auth login` profile is available,
 *                                    offline scripted model otherwise)
 *        npm run demo -- --offline  (force the scripted model)
 *        npm run demo -- --fresh    (wipe persisted state first)
 *
 * Things to try:
 *   - plain chat (streams token by token)
 *   - "email bob about the launch"  → approval-gated action (y/n prompt)
 *   - "write a note about X"        → workspace tool call
 *   - Ctrl+C mid-answer, then rerun → chat recovery continues the turn
 *   - /history /ws /clear /quit
 */
import { rmSync } from "node:fs";
import readline from "node:readline/promises";
import { z } from "zod";

import { Think, type StreamCallback } from "../src/app/think.js";
import type { AgentHost } from "../src/app/agent.js";
import { action, type Action } from "../src/domain/actions/actions.js";
import type { ConversationEvent } from "../src/domain/events/log.js";
import type { ModelClient, ModelRequest } from "../src/ports/model.js";
import { createFileKeyValueStore } from "../src/adapters/node/file-store.js";
import { createRealAlarmTimer, realClock } from "../src/adapters/node/real-time.js";
import { createAnthropicModel } from "../src/adapters/anthropic/model.js";

// --------------------------------------------------------------------------
// Terminal colors (no deps)
// --------------------------------------------------------------------------
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
const short = (v: unknown, n = 120): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// --------------------------------------------------------------------------
// Offline scripted model — touchable without an API key
// --------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function createOfflineModel(): ModelClient {
  return {
    async *stream(request: ModelRequest) {
      const last = request.messages.at(-1);

      // After a tool ran, wrap up referencing its result.
      if (last?.role === "tool") {
        const result = last.content[0];
        const text =
          result?.isError === true
            ? `The ${result.toolName} call failed: ${short(result.output)}. `
            : `Done — the ${result?.toolName} call came back with ${short(result?.output, 80)}. `;
        for (const word of `${text}(offline demo model)`.split(" ")) {
          yield { type: "text-delta" as const, text: `${word} ` };
          await sleep(30);
        }
        yield { type: "finish" as const, finishReason: "stop" as const };
        return;
      }

      const userText =
        last?.role === "user"
          ? last.content
              .map((p) => (p.type === "text" ? p.text : ""))
              .join(" ")
              .toLowerCase()
          : "";

      if (userText.includes("email")) {
        yield {
          type: "tool-call" as const,
          toolCallId: `call_${Date.now()}`,
          toolName: "send_demo_email",
          input: { to: "bob@example.com", subject: "About the launch" },
        };
        yield { type: "finish" as const, finishReason: "tool-calls" as const };
        return;
      }

      if (userText.includes("note")) {
        yield {
          type: "tool-call" as const,
          toolCallId: `call_${Date.now()}`,
          toolName: "write",
          input: { path: `notes/note-${Date.now()}.md`, content: `# Note\n\n${userText}\n` },
        };
        yield { type: "finish" as const, finishReason: "tool-calls" as const };
        return;
      }

      const canned =
        "I'm the offline demo model — a scripted ModelClient behind the same port a real " +
        "provider adapter implements. Everything else here is the real rebuilt system: the " +
        "turn engine is streaming these words as chunk events into a durable log, the session " +
        "is persisting this exchange to a JSON file, and if you kill me mid-sentence with " +
        "Ctrl+C and restart, chat recovery will pick this turn back up. Try 'email bob' for an " +
        "approval flow, or 'write a note about ducks' for a workspace tool call.";
      for (const word of canned.split(" ")) {
        yield { type: "text-delta" as const, text: `${word} ` };
        await sleep(35);
      }
      yield { type: "finish" as const, finishReason: "stop" as const };
    },
  };
}

// --------------------------------------------------------------------------
// The demo agent
// --------------------------------------------------------------------------
class DemoAgent extends Think<unknown> {
  model: ModelClient = createOfflineModel();

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getSystemPrompt(): string {
    return (
      "You are a concise, friendly assistant running inside a rebuilt agent runtime demo. " +
      "You have workspace file tools and a send_demo_email action (which requires human " +
      "approval). Keep answers short unless asked otherwise."
    );
  }

  protected override getActions(): Record<string, Action> {
    return {
      send_demo_email: action({
        description: "Send an email (demo: pretends to send). Requires human approval.",
        inputSchema: z.object({
          to: z.string().describe("Recipient address"),
          subject: z.string().describe("Subject line"),
          body: z.string().optional().describe("Email body"),
        }),
        approval: true,
        approvalSummary: "Send an email on your behalf",
        approvalRisk: "medium",
        idempotencyKey: ({ input }) => `email:${input.to}:${input.subject}`,
        execute: async (input) => {
          await sleep(300);
          return { sent: true, to: input.to, subject: input.subject, messageId: `demo_${Date.now()}` };
        },
      }),
    };
  }
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
const statePath = new URL("./.demo-state.json", import.meta.url).pathname;
if (args.includes("--fresh")) rmSync(statePath, { force: true });

const store = createFileKeyValueStore(statePath);
const alarm = createRealAlarmTimer(realClock);

const host: AgentHost = {
  className: "DemoAgent",
  name: "demo",
  store,
  alarm,
  clock: realClock,
};

const agent = new DemoAgent(host);
alarm.onAlarm(() => agent.onAlarm());

const hasCredentials =
  !args.includes("--offline") &&
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
if (hasCredentials) {
  agent.model = createAnthropicModel({ model: process.env.DEMO_MODEL ?? "claude-opus-4-8" });
}

// Flush persisted state on any exit so Ctrl+C mid-turn leaves recoverable
// state on disk (the point of the recovery demo).
process.on("exit", () => store.flushSync());
process.on("SIGINT", () => {
  store.flushSync();
  process.stdout.write(dim("\n[killed mid-flight — rerun `npm run demo` to watch recovery]\n"));
  process.exit(130);
});

// --------------------------------------------------------------------------
// Event rendering: this CLI is a transport adapter over the event log
// --------------------------------------------------------------------------
let pendingApproval: { toolCallId: string; toolName: string } | undefined;
let settleWaiters: Array<(outcome: string) => void> = [];

function onEvent(event: ConversationEvent): void {
  switch (event.type) {
    case "chunk": {
      const chunk = event.chunk;
      switch (chunk.type) {
        case "start":
          process.stdout.write(`\n${cyan("assistant>")} `);
          break;
        case "text-delta":
          process.stdout.write(chunk.delta);
          break;
        case "reasoning-delta":
          process.stdout.write(dim(chunk.delta));
          break;
        case "tool-input-available":
          process.stdout.write(`\n  ${yellow("⚙")} ${chunk.toolName} ${dim(short(chunk.input))}\n`);
          break;
        case "tool-approval-requested":
          pendingApproval = { toolCallId: chunk.toolCallId, toolName: chunk.toolName };
          process.stdout.write(
            `\n  ${yellow("⚠ approval required:")} ${chunk.toolName} ${dim(short(chunk.input))}\n`,
          );
          break;
        case "tool-output-available":
          process.stdout.write(`  ${dim(`↳ ${short(chunk.output)}`)}\n`);
          break;
        case "error":
          process.stdout.write(`\n${red(`✗ ${chunk.errorText}`)}\n`);
          break;
        case "finish":
          process.stdout.write("\n");
          break;
      }
      break;
    }
    case "recovering:changed":
      if (event.active) process.stdout.write(yellow("\n[recovering an interrupted turn…]\n"));
      break;
    case "turn:settled": {
      const waiters = settleWaiters;
      settleWaiters = [];
      for (const w of waiters) w(event.outcome);
      break;
    }
    default:
      break;
  }
}

agent.events().subscribe("live", (stored) => onEvent(stored.event));

const waitForSettle = (): Promise<string> => new Promise((resolve) => settleWaiters.push(resolve));

// --------------------------------------------------------------------------
// REPL
// --------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let stdinClosed = false;
rl.on("close", () => {
  stdinClosed = true;
});

/** rl.question that returns null instead of throwing once stdin has closed (piped input). */
async function ask(prompt: string): Promise<string | null> {
  if (stdinClosed) return null;
  try {
    return await rl.question(prompt);
  } catch {
    return null;
  }
}

async function handleApproval(): Promise<void> {
  while (pendingApproval) {
    const { toolCallId, toolName } = pendingApproval;
    pendingApproval = undefined;
    const raw = await ask(`${yellow(`approve ${toolName}? [y/N]`)} `);
    if (raw === null) return;
    const answer = raw.trim().toLowerCase();
    const settled = waitForSettle();
    await agent.resolveApproval({ toolCallId, approved: answer === "y" || answer === "yes" });
    await settled; // the continuation turn owns the final answer
  }
}

async function main(): Promise<void> {
  process.stdout.write(
    `${cyan("── rebuilt Think demo ──")}\n` +
      `model: ${hasCredentials ? (process.env.DEMO_MODEL ?? "claude-opus-4-8") : "offline scripted model (set ANTHROPIC_API_KEY for the real thing)"}\n` +
      `state: ${statePath}\n` +
      `commands: /history /ws /clear /quit — Ctrl+C mid-answer to demo recovery\n`,
  );

  const recovering = waitForSettle();
  await agent.start();
  if (agent.isRecovering()) {
    process.stdout.write(yellow("\n[interrupted turn found — recovery in progress]\n"));
    await recovering;
  }

  for (;;) {
    const raw = await ask(`\n${cyan("you>")} `);
    if (raw === null) break; // stdin closed (piped input ended)
    const line = raw.trim();
    if (!line) continue;

    if (line === "/quit" || line === "/exit") break;
    if (line === "/clear") {
      await agent.clearMessages();
      process.stdout.write(dim("[conversation cleared]\n"));
      continue;
    }
    if (line === "/history") {
      const messages = await agent.getMessages();
      for (const m of messages) {
        const text = m.parts
          .map((p) => ("text" in p && typeof p.text === "string" ? p.text : `[${p.type}]`))
          .join(" ");
        process.stdout.write(`${dim(`${m.role}:`)} ${short(text, 200)}\n`);
      }
      continue;
    }
    if (line === "/ws") {
      // Debug peek at the workspace's slice of the store (prefix "think:ws:").
      const entries = store.list({ prefix: "think:ws:" });
      if (entries.size === 0) process.stdout.write(dim("[workspace empty]\n"));
      for (const [key, value] of entries) {
        process.stdout.write(`${key.replace("think:ws:", "")} ${dim(short(value, 100))}\n`);
      }
      continue;
    }

    try {
      const callback: StreamCallback | undefined = undefined;
      const result = await agent.chat(line, callback);
      if (result.outcome === "suspended") await handleApproval();
      if (result.outcome === "error" && result.error) {
        process.stdout.write(red(`\n[turn failed: ${short(result.error.message, 200)}]\n`));
      }
    } catch (err) {
      process.stdout.write(red(`\n[unexpected: ${short(err instanceof Error ? err.message : err)}]\n`));
    }
  }

  rl.close();
  alarm.dispose();
  store.flushSync();
  process.stdout.write(dim("bye\n"));
  process.exit(0);
}

void main();
