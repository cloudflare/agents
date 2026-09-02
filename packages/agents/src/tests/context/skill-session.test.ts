import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ContextBlocks,
  reclaimLoadedSkill,
  restoreLoadedSkills,
  type SkillProvider
} from "../../context";
import type { SessionMessage } from "../../sessions";
import type { SessionHarnessObject } from "../capabilities/sessions";

/**
 * Skill state lives in the transcript, not on the Session handle: the
 * `agents/context` helpers read it back from a real Session and rewrite a
 * stored tool result when a skill is unloaded.
 */

const skills: SkillProvider = {
  get: async () => "- guide: Project guide",
  load: async () => "full guide"
};

function skillCall(
  id: string,
  toolName: "load_context" | "unload_context",
  key: string,
  output: unknown
): SessionMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${toolName}`,
        toolName,
        toolCallId: `call-${id}`,
        state: "output-available",
        input: { label: "skills", key },
        output
      }
    ]
  };
}

describe("session-backed skill state", () => {
  it("restores loaded skills from the transcript and reclaims their output", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        skillCall("skill-result", "load_context", "guide", "full guide")
      );

      const context = new ContextBlocks([
        { label: "skills", provider: skills }
      ]);
      await context.load();
      await restoreLoadedSkills(context, session);
      expect(context.getLoadedSkillKeys()).toEqual(new Set(["skills:guide"]));

      await reclaimLoadedSkill(session, "skills", "guide");
      const stored = await session.getMessage("skill-result", {
        reconstruct: "pointer"
      });
      expect(stored?.parts[0].output).toBe("[skill unloaded: guide]");

      // The reclaimed marker is itself the record that the skill is gone.
      const reread = new ContextBlocks([{ label: "skills", provider: skills }]);
      await reread.load();
      await restoreLoadedSkills(reread, session);
      expect(reread.getLoadedSkillKeys()).toEqual(new Set());
    });
  });

  it("treats a recorded unload_context call as an unload", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        skillCall("load", "load_context", "guide", "full guide")
      );
      await session.appendMessage(
        skillCall("unload", "unload_context", "guide", "unloaded")
      );

      const context = new ContextBlocks([
        { label: "skills", provider: skills }
      ]);
      await context.load();
      await restoreLoadedSkills(context, session);
      expect(context.getLoadedSkillKeys()).toEqual(new Set());
    });
  });

  it("reads nothing when no block can load skills", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        skillCall("skill-result", "load_context", "guide", "full guide")
      );

      const context = new ContextBlocks([
        { label: "soul", provider: { get: async () => "identity" } }
      ]);
      await context.load();
      await restoreLoadedSkills(context, session);
      expect(context.getLoadedSkillKeys()).toEqual(new Set());
    });
  });

  it("leaves the transcript alone when no matching skill result exists", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      await session.appendMessage(
        skillCall("skill-result", "load_context", "guide", "full guide")
      );

      await reclaimLoadedSkill(session, "skills", "other");
      const stored = await session.getMessage("skill-result", {
        reconstruct: "pointer"
      });
      expect(stored?.parts[0].output).toBe("full guide");
    });
  });
});
