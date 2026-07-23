import { describe, expect, it } from "vitest";
import openPrSkill from "../skills/open-pr/SKILL.md?raw";
import reproduceSkill from "../skills/reproduce/SKILL.md?raw";

const skills = [
  ["reproduce", reproduceSkill],
  ["open-pr", openPrSkill]
] as const;

describe("agent-think skill target contract", () => {
  for (const [name, content] of skills) {
    it(`${name} fails closed without immutable run context`, () => {
      expect(content).toContain("<agent-think-run>");
      expect(content).toContain("Never infer or substitute another target");
    });

    it(`${name} attributes posted reports to the requester`, () => {
      expect(content).toContain("Requested by @<requestedBy>");
    });

    it(`${name} reacts to the triggering comment from durable context`, () => {
      expect(content).toContain("<trigger-comment-id>/reactions");
      expect(content).toContain("content=rocket");
    });
  }
});
