import { defineScheduledTasks, Think } from "@cloudflare/think";
import type { Session } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

type Env = Cloudflare.Env & {
  AI: Ai;
};

/**
 * A personal assistant with durable memory and proactive scheduled tasks.
 *
 * `configureSession` gives the model a writable `memory` context block that it
 * updates on its own (via the `set_context` tool) and that survives restarts
 * and hibernation. `getScheduledTasks` runs the agent proactively on a
 * schedule, even when nobody is connected.
 */
export class Assistant extends Think<Env> {
  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code",
      {
        sessionAffinity: this.sessionAffinity
      }
    );
  }

  override configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            "You are a warm, proactive personal assistant. Remember what matters to the user and help them stay on top of their day."
        }
      })
      .withContext("memory", {
        description:
          "Durable facts about the user: their name, preferences, ongoing projects, and commitments.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }

  override getDefaultTimezone() {
    return "UTC";
  }

  override getScheduledTasks() {
    return defineScheduledTasks({
      dailyBriefing: {
        schedule: "every weekday at 09:00",
        prompt:
          "Give the user a short morning briefing based on what you remember: outstanding commitments and anything they asked to be reminded about."
      }
    });
  }
}
