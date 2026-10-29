import { describe, expect, it } from "vitest";
import { Context } from "../../context";
import { Sessions, type Session, type SessionMessage } from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * Tries to break `Context` rather than confirm it. Random sessions on a real
 * Durable Object mix turns, block changes, refreshes, regenerations from
 * earlier messages, and compactions. After every step, for every message on
 * the active path, the prompt and the pending changes must not depend on
 * how much history the host passes in: any window that ends at a message
 * sees exactly what the full path to it sees.
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

describe("Context invariants", () => {
  const seeds = 16;
  for (let seed = 1; seed <= seeds; seed++) {
    it(`a window agrees with the full path (seed ${seed})`, async () => {
      await run(seed);
    });
  }
});
