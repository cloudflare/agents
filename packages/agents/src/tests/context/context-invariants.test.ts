import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Context } from "../../context";
import { Sessions, type Session, type SessionMessage } from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * Tries to break `Context` rather than confirm it. Random sessions on a real
 * Durable Object mix turns, block changes, refreshes, regenerations from
 * earlier messages, and compactions, and check two promises:
 *
 * - what the model has seen does not depend on how much history the host
 *   passes in: any window that ends at a message sees exactly what the full
 *   path to it sees;
 * - each turn's request extends the previous one byte for byte, so the
 *   provider's prefix cache holds, except where the cache is deliberately
 *   given up (a refresh, a compaction, or a switch to another branch), and
 *   a change is delivered once.
 */

/** Deterministic random numbers, so a failure replays from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function text(id: string, role: string, body: string): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
}

/** Every window of the path to `leafId` must agree with the full path. */
async function expectWindowsAgree(
  session: Session,
  context: Context,
  leafId: string,
  step: string
): Promise<void> {
  const path = await session.getHistory({ leafId });
  const full = {
    system: await context.freezeSystemPrompt({ messages: path }),
    reminder: await context.reminder({ messages: path })
  };
  for (let start = 1; start < path.length; start++) {
    const window = path.slice(start);
    expect(
      {
        system: await context.freezeSystemPrompt({ messages: window }),
        reminder: await context.reminder({ messages: window })
      },
      `${step}: window from ${path[start].id} to ${leafId}`
    ).toEqual(full);
  }
}

async function run(seed: number): Promise<void> {
  await withCapabilityHarness(async ({ storage, install }) => {
    const next = random(seed);
    const sessions = new Sessions();
    install(sessions);
    const session = sessions.session();
    const values = { soul: "soul-0", environment: "env-0" };
    const context = new Context(session, {
      storage,
      blocks: [
        { label: "soul", provider: { get: async () => values.soul } },
        { label: "memory", description: "Learned facts" },
        {
          label: "environment",
          provider: { get: async () => values.environment },
          whenChanged: "remind"
        }
      ]
    });

    let id = 0;
    const answered: string[] = [];
    for (let step = 0; step < 40; step++) {
      const roll = next();
      const label = `seed ${seed} step ${step}`;
      if (roll < 0.45) {
        // A turn: the user message, the check, then the recorded build.
        const userId = `u${id++}`;
        await session.appendMessage(text(userId, "user", label));
        await expectWindowsAgree(session, context, userId, `${label} turn`);
        await context.build();
        await session.appendMessage(text(`a${id++}`, "assistant", "reply"));
        answered.push(userId);
      } else if (roll < 0.6) {
        values.environment = `env-${step}`;
      } else if (roll < 0.7) {
        values.soul = `soul-${step}`;
        await context.refreshSystemPrompt();
      } else if (roll < 0.85 && answered.length > 0) {
        // Regenerate an earlier answer: that branch becomes the active one.
        const target = answered[Math.floor(next() * answered.length)];
        await expectWindowsAgree(session, context, target, `${label} regen`);
        await context.prepare({
          messages: await session.getHistory({ leafId: target })
        });
        await session.appendMessage(
          text(`a${id++}`, "assistant", "another reply"),
          { parentId: target }
        );
      } else {
        // Compact the older part of the active path.
        const path = await session.getHistory();
        const stored = path.filter((m) => !m.id.startsWith("compaction_"));
        if (stored.length >= 4) {
          await session.addCompaction(
            "summary",
            stored[0].id,
            stored[stored.length - 3].id
          );
        }
      }
      // Every user message on the active path agrees with its windows.
      for (const message of await session.getHistory()) {
        if (message.role === "user") {
          await expectWindowsAgree(session, context, message.id, label);
        }
      }
    }
  });
}

/** What the provider is sent for one turn. */
type Request = { system: string; messages: ModelMessage[] };

async function toModel(messages: SessionMessage[]): Promise<ModelMessage[]> {
  // SAFETY: session messages are UI messages by structure.
  return convertToModelMessages(messages as UIMessage[]);
}

async function runPrefix(seed: number): Promise<void> {
  await withCapabilityHarness(async ({ storage, install }) => {
    const next = random(seed);
    const sessions = new Sessions();
    install(sessions);
    const session = sessions.session();
    const values = { soul: "soul-0", environment: "env-0" };
    const context = new Context(session, {
      storage,
      blocks: [
        { label: "soul", provider: { get: async () => values.soul } },
        { label: "memory", description: "Learned facts" },
        {
          label: "environment",
          provider: { get: async () => values.environment },
          whenChanged: "remind"
        }
      ]
    });

    let id = 0;
    // The environment value the model on each answered turn's branch had
    // been shown, by user message: a change is delivered per branch.
    const shown = new Map<string, string>();
    let branchShown: string | undefined;
    // The previous turn's request and the reply that answered it.
    let previous: { request: Request; reply: SessionMessage } | undefined;
    // Why the next request may not extend the previous one.
    let busted: string | undefined;
    let refreshed = false;

    for (let step = 0; step < 40; step++) {
      const roll = next();
      const label = `seed ${seed} step ${step}`;
      if (roll < 0.5) {
        const userId = `u${id++}`;
        await session.appendMessage(text(userId, "user", label));
        const built = await context.build();
        expect(built.reminder, label).toBeNull();
        const request = {
          system: built.system,
          messages: await toModel(built.messages)
        };

        if (previous && !busted) {
          expect(request.system, `${label}: system prompt`).toBe(
            previous.request.system
          );
          const prefix = [
            ...previous.request.messages,
            ...(await toModel([previous.reply]))
          ];
          expect(
            request.messages.slice(0, prefix.length),
            `${label}: earlier messages`
          ).toEqual(prefix);
        }

        // A change rides on this turn's user message once, and only when
        // the model on this branch has not been shown the current value.
        const expectReminder =
          !refreshed &&
          branchShown !== undefined &&
          branchShown !== values.environment;
        const sent = built.messages.at(-1);
        expect(sent?.id, label).toBe(userId);
        expect(sent?.parts.length, `${label}: reminder only on change`).toBe(
          expectReminder ? 2 : 1
        );

        const reply = text(`a${id++}`, "assistant", "reply");
        await session.appendMessage(reply);
        branchShown = values.environment;
        shown.set(userId, branchShown);
        previous = { request, reply };
        busted = undefined;
        refreshed = false;
      } else if (roll < 0.65) {
        values.environment = `env-${step}`;
      } else if (roll < 0.75) {
        values.soul = `soul-${step}`;
        await context.refreshSystemPrompt();
        busted = "refresh";
        refreshed = true;
      } else if (roll < 0.88 && shown.size > 0) {
        // Answer an earlier turn again; its branch becomes the active one.
        const turns = [...shown.keys()];
        const target = turns[Math.floor(next() * turns.length)];
        await session.appendMessage(
          text(`a${id++}`, "assistant", "another reply"),
          { parentId: target }
        );
        branchShown = shown.get(target);
        busted = "branch";
      } else {
        const path = await session.getHistory();
        const stored = path.filter((m) => !m.id.startsWith("compaction_"));
        if (stored.length >= 4) {
          await session.addCompaction(
            "summary",
            stored[0].id,
            stored[stored.length - 3].id
          );
          busted = "compaction";
        }
      }
    }
  });
}

describe("Context invariants", () => {
  const seeds = 16;
  for (let seed = 1; seed <= seeds; seed++) {
    it(`a window agrees with the full path (seed ${seed})`, async () => {
      await run(seed);
    });
  }

  for (let seed = 1; seed <= seeds; seed++) {
    it(`each request extends the previous one (seed ${seed})`, async () => {
      await runPrefix(seed);
    });
  }
});
