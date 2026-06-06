/**
 * Live #1691 repro orchestrator.
 *
 * Drives a real-LLM AIChatAgent through the exact #1691 sequence and SIGKILLs
 * `wrangler dev` mid-stream, then restarts against the same persisted state:
 *
 *   1. Turn 1: a short prompt that completes  -> assistant message #1.
 *   2. Turn 2: a long-streaming prompt; SIGKILL `wrangler dev` mid-stream
 *      (before the assistant message is persisted).
 *   3. Restart wrangler with the same --persist-to dir -> recovery fires.
 *   4. Verdict: turn 2 must become its OWN assistant message (#2), and turn 1
 *      must be untouched. The #1691 bug merged turn 2 into turn 1 (still one
 *      assistant message, turn-1 text corrupted).
 *
 * Run (from wip/issue-1691-live):
 *   pnpm run repro -- --provider workers-ai
 *   pnpm run repro -- --provider openai
 *   pnpm run repro -- --provider anthropic
 *
 * Keys for openai/anthropic come from .dev.vars (read automatically by
 * `wrangler dev`). Workers AI uses your `wrangler login` account.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily, Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// --- Networking guards (mirrors packages/ai-chat/src/e2e-tests) -------------
// Abandoned happy-eyeballs sockets racing a server mid-SIGKILL can throw a
// connect-time setTypeOfService EINVAL; disable dual-stack racing and make the
// optional setter best-effort.
setDefaultAutoSelectFamily(false);
{
  const proto = Socket.prototype as unknown as {
    setTypeOfService?: (tos: number) => unknown;
  };
  const original = proto.setTypeOfService;
  if (typeof original === "function") {
    proto.setTypeOfService = function (this: unknown, tos: number) {
      try {
        return original.call(this, tos);
      } catch {
        return this;
      }
    };
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, "..");

type Args = {
  provider: string;
  engine: string;
  port: number;
  killDelayMs: number;
  settleMs: number;
  count: number;
  stableMs: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    provider: get("provider", "workers-ai"),
    engine: get("engine", "ai-chat"),
    port: Number(get("port", "18991")),
    killDelayMs: Number(get("kill-delay", "1500")),
    settleMs: Number(get("settle", "60000")),
    count: Number(get("count", "40")),
    stableMs: Number(get("stable", "20000"))
  };
}

const args = parseArgs();
const AGENT_URL = `http://127.0.0.1:${args.port}`;
// Agent route slug: ai-chat -> live-chat-agent, think -> live-think-agent.
const AGENT_SLUG =
  args.engine === "think" ? "live-think-agent" : "live-chat-agent";
const AGENT_NAME = `live-1691-${args.engine}-${args.provider}`;
const AGENT_PATH = `/agents/${AGENT_SLUG}/${AGENT_NAME}`;
const PERSIST_DIR = path.join(
  PKG_DIR,
  `.wrangler-state-${args.engine}-${args.provider}`
);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  console.log(`[repro] ${msg}`);
}

function killProcessOnPort(port: number): void {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`)
      .toString()
      .trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already dead
      }
    }
  } catch {
    // lsof unavailable
  }
}

function startWrangler(): ChildProcess {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      path.join(PKG_DIR, "wrangler.jsonc"),
      "--port",
      String(args.port),
      "--persist-to",
      PERSIST_DIR,
      "--var",
      `LLM_PROVIDER:${args.provider}`
    ],
    {
      cwd: PKG_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );
  child.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });
  return child;
}

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/`);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // not ready
    }
    await sleep(delayMs);
  }
  throw new Error("wrangler did not start in time");
}

async function waitForPortFree(maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/`);
      await res.body?.cancel();
    } catch {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`port ${args.port} did not free in time`);
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) return resolve();
    const fallback = setTimeout(resolve, 3000);
    child.on("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  });
}

type Summary = {
  provider: string;
  recoveryCount: number;
  assistantCount: number;
  userCount: number;
  messages: Array<{ id: string; role: string; text: string }>;
};

type UIMessageLike = {
  id: string;
  role: string;
  parts: Array<{ type: "text"; text: string }>;
};

function callRpc(method: string, rpcArgs: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${AGENT_URL}${AGENT_PATH}`);
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC ${method} timed out`));
    }, 15000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "rpc", id, method, args: rpcArgs }));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          msg.success
            ? resolve(msg.result)
            : reject(new Error(msg.error || "RPC failed"));
        }
      } catch {
        // ignore non-rpc frames
      }
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err as unknown as Error);
    };
  });
}

const getSummary = () => callRpc("summary") as Promise<Summary>;

/**
 * Send a chat turn. If `waitForDone` is true, resolve when the server sends a
 * done response; otherwise resolve after `holdMs` (used to keep the socket open
 * while the stream runs, then return so the caller can SIGKILL mid-stream).
 */
function sendChat(
  messages: UIMessageLike[],
  opts: { waitForDone: boolean; holdMs: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${AGENT_URL}${AGENT_PATH}`);
    let settled = false;
    // Accumulate streamed assistant text so we can measure the partial that had
    // streamed at the moment we SIGKILL (used to prove a continuation actually
    // EXTENDED the partial rather than appending nothing).
    let streamedText = "";
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(streamedText);
    };
    const hardTimeout = setTimeout(
      finish,
      opts.waitForDone ? 60000 : opts.holdMs
    );
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: { method: "POST", body: JSON.stringify({ messages }) }
        })
      );
      if (!opts.waitForDone) {
        setTimeout(() => {
          clearTimeout(hardTimeout);
          finish();
        }, opts.holdMs);
      }
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type !== "cf_agent_use_chat_response") return;
        if (typeof msg.body === "string" && msg.body) {
          try {
            const chunk = JSON.parse(msg.body);
            if (
              chunk.type === "text-delta" &&
              typeof chunk.delta === "string"
            ) {
              streamedText += chunk.delta;
            }
          } catch {
            // not a JSON chunk frame
          }
        }
        if (opts.waitForDone && msg.done) {
          clearTimeout(hardTimeout);
          finish();
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = (err) => {
      if (settled) return;
      clearTimeout(hardTimeout);
      reject(err as unknown as Error);
    };
  });
}

async function pollUntil(
  label: string,
  done: (s: Summary) => boolean,
  { attempts = 60, delayMs = 1000 } = {}
): Promise<Summary> {
  let last: Summary | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await getSummary();
      log(
        `${label} poll ${i + 1}: assistants=${last.assistantCount} users=${last.userCount} recoveries=${last.recoveryCount}`
      );
      if (done(last)) return last;
    } catch {
      log(`${label} poll ${i + 1}: agent not ready`);
    }
    await sleep(delayMs);
  }
  if (last) return last;
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Continuation-quality probe (independent of the #1691 isolation check).
 *
 * Turn 2 asks the model for a numbered list "1.", "2.", ... When recovery
 * CONTINUES an interrupted turn it feeds the partial assistant message back as
 * a trailing assistant message (assistant *prefill*) and APPENDS whatever the
 * model emits. So:
 *   - A provider that supports prefill continues the list: 1..K then K+1..40,
 *     strictly ascending, no repeats  -> CLEAN_CONTINUATION.
 *   - A provider that does NOT continue regenerates from scratch; appended onto
 *     the partial that yields a reset (numbers drop back to 1) and duplicates
 *     -> DUPLICATED_OR_RESTARTED.
 */
function analyzeContinuation(text: string): {
  count: number;
  distinct: number;
  decreases: number;
  duplicates: number;
  first: number[];
  last: number[];
  verdict: string;
} {
  const nums: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,3})[.)]/);
    if (m) nums.push(Number(m[1]));
  }
  let decreases = 0;
  let prev = -Infinity;
  const seen = new Map<number, number>();
  for (const n of nums) {
    if (n < prev) decreases++;
    prev = n;
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const c of seen.values()) if (c > 1) duplicates += c - 1;
  let verdict: string;
  if (nums.length === 0) verdict = "NO_LIST";
  else if (decreases === 0 && duplicates === 0) verdict = "CLEAN_CONTINUATION";
  else verdict = "DUPLICATED_OR_RESTARTED";
  return {
    count: nums.length,
    distinct: seen.size,
    decreases,
    duplicates,
    first: nums.slice(0, 6),
    last: nums.slice(-6),
    verdict
  };
}

/**
 * Wait until the recovered turn-2 assistant message stops growing. `assistantCount>=2`
 * goes true the instant the PARTIAL is persisted as its own message — which is
 * BEFORE the scheduled continuation alarm fires and extends it. Reading then
 * would mis-measure the continuation. Poll until the turn-2 text is unchanged
 * for `stableMs`.
 */
async function pollUntilStable(
  turn1AssistantId: string,
  { stableMs = 6000, timeoutMs = 120000, delayMs = 1000 } = {}
): Promise<Summary> {
  let last = await getSummary();
  let lastText = "";
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      last = await getSummary();
    } catch {
      await sleep(delayMs);
      continue;
    }
    const t2 = last.messages.find(
      (m) => m.role === "assistant" && m.id !== turn1AssistantId
    );
    const text = t2?.text ?? "";
    if (text !== lastText) {
      lastText = text;
      stableSince = Date.now();
    } else if (text.length > 0 && Date.now() - stableSince >= stableMs) {
      return last;
    }
    log(
      `stabilize: turn2 chars=${text.length} items=${analyzeContinuation(text).count} stableFor=${Date.now() - stableSince}ms`
    );
    await sleep(delayMs);
  }
  return last;
}

function cleanup(): void {
  killProcessOnPort(args.port);
  try {
    fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const TURN1_TEXT = "Reply with EXACTLY this and nothing else: TURN-ONE-OK";
const TURN2_TEXT =
  `Count from 1 to ${args.count}. For each number, write one short sentence on ` +
  "its own line, formatted like '1. <sentence>'. Do not stop early.";

async function main(): Promise<number> {
  log(
    `engine=${args.engine} provider=${args.provider} port=${args.port} killDelay=${args.killDelayMs}ms`
  );
  cleanup();

  let wrangler = startWrangler();
  try {
    await waitForReady();
    log("wrangler ready");

    // --- Turn 1: short, let it complete -------------------------------------
    const user1: UIMessageLike = {
      id: `user-1-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: TURN1_TEXT }]
    };
    log("turn 1: sending short prompt");
    await sendChat([user1], { waitForDone: true, holdMs: 0 });
    const afterTurn1 = await pollUntil(
      "turn 1 complete",
      (s) => s.assistantCount >= 1,
      { attempts: 40 }
    );
    if (afterTurn1.assistantCount < 1) {
      log("FAIL: turn 1 never produced an assistant message");
      return 1;
    }
    const assistant1 = afterTurn1.messages.find((m) => m.role === "assistant")!;
    const assistant1Text = assistant1.text;
    log(
      `turn 1 assistant id=${assistant1.id} text=${JSON.stringify(assistant1Text)}`
    );

    // Full conversation a real client would send for turn 2.
    const user2: UIMessageLike = {
      id: `user-2-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: TURN2_TEXT }]
    };
    const turn2Messages: UIMessageLike[] = [
      ...afterTurn1.messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: "text" as const, text: m.text }]
      })),
      user2
    ];

    // --- Turn 2: long stream, SIGKILL mid-stream ----------------------------
    log(
      `turn 2: sending long prompt, will SIGKILL after ${args.killDelayMs}ms`
    );
    const partialAtKill = await sendChat(turn2Messages, {
      waitForDone: false,
      holdMs: args.killDelayMs
    });
    const partialItems = analyzeContinuation(partialAtKill).count;
    log(
      `turn 2: SIGKILL wrangler mid-stream (partial streamed ${partialItems} list items, ${partialAtKill.length} chars)`
    );
    await killProcess(wrangler);
    await waitForPortFree();

    // --- Restart, let recovery run ------------------------------------------
    log("restarting wrangler against the same persisted state");
    wrangler = startWrangler();
    await waitForReady();

    await pollUntil(
      "recovery",
      (s) => s.recoveryCount >= 1 && s.assistantCount >= 2,
      { attempts: Math.ceil(args.settleMs / 1000), delayMs: 1000 }
    );
    // The continuation runs in a scheduled alarm AFTER the partial is persisted;
    // wait for the recovered turn-2 message to stop growing before measuring.
    const final = await pollUntilStable(assistant1.id, {
      stableMs: args.stableMs,
      timeoutMs: args.settleMs
    });

    // --- Verdict ------------------------------------------------------------
    console.log("\n================ RESULT ================");
    console.log(`provider:        ${final.provider}`);
    console.log(`recoveryCount:   ${final.recoveryCount}`);
    console.log(`assistantCount:  ${final.assistantCount}`);
    console.log(`userCount:       ${final.userCount}`);
    for (const m of final.messages) {
      const preview = m.text.replace(/\s+/g, " ").slice(0, 80);
      console.log(
        `  - ${m.role.padEnd(9)} ${m.id}  ${JSON.stringify(preview)}`
      );
    }
    console.log("========================================\n");

    const turn1Assistant = final.messages.find((m) => m.id === assistant1.id);
    const turn2Assistant = final.messages.find(
      (m) => m.role === "assistant" && m.id !== assistant1.id
    );

    // Continuation-quality report (informational; orthogonal to #1691).
    if (turn2Assistant) {
      const c = analyzeContinuation(turn2Assistant.text);
      const extended = c.count > partialItems;
      console.log("=========== CONTINUATION QUALITY ===========");
      console.log(`provider:        ${final.provider}`);
      console.log(`partial @ kill:  ${partialItems} items`);
      console.log(`final items:     ${c.count} (distinct ${c.distinct})`);
      console.log(`extended:        ${extended ? "yes" : "no"}`);
      console.log(`resets:          ${c.decreases}`);
      console.log(`duplicates:      ${c.duplicates}`);
      console.log(`first nums:      [${c.first.join(", ")}]`);
      console.log(`last nums:       [${c.last.join(", ")}]`);
      console.log(
        `verdict:         ${c.verdict}${c.verdict === "CLEAN_CONTINUATION" && !extended ? " (but added nothing — inconclusive)" : ""}`
      );
      console.log("============================================\n");
    }

    if (final.recoveryCount < 1) {
      log(
        "INCONCLUSIVE: recovery never fired (turn 2 likely finished before the SIGKILL). Retry with a smaller --kill-delay or a longer prompt."
      );
      return 2;
    }
    if (final.assistantCount < 2) {
      log(
        "BUG (#1691 reproduced): turn 2 was merged into the previous assistant message instead of becoming its own."
      );
      if (turn1Assistant && turn1Assistant.text !== assistant1Text) {
        log(
          `turn-1 assistant text was corrupted: ${JSON.stringify(turn1Assistant.text)}`
        );
      }
      return 1;
    }
    if (!turn1Assistant || turn1Assistant.text !== assistant1Text) {
      log(
        `BUG: turn-1 assistant message changed during recovery. before=${JSON.stringify(assistant1Text)} after=${JSON.stringify(turn1Assistant?.text)}`
      );
      return 1;
    }

    log(
      "PASS: turn 2 recovered as its own assistant message and turn 1 is untouched."
    );
    return 0;
  } finally {
    await killProcess(wrangler);
    cleanup();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[repro] error:", err);
    cleanup();
    process.exit(1);
  });
