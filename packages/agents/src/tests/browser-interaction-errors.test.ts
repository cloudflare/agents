import { describe, expect, it } from "vitest";
import {
  BrowserInteractionError,
  INTERACTION_ERROR_TEACHING,
  INTERACTION_ERROR_CODES,
  VERB_DESCRIPTIONS,
  VERB_NAMES,
  isBrowserInteractionError
} from "../browser/interaction";

describe("BrowserInteractionError", () => {
  it("carries a machine code and a fix-oriented default message", () => {
    const error = new BrowserInteractionError("STALE_REF");
    expect(error.code).toBe("STALE_REF");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BrowserInteractionError");
    // The default message is the teaching sentence for the code — the model
    // reads this text, so it must say what to do next, not just what broke.
    expect(error.message).toBe(INTERACTION_ERROR_TEACHING.STALE_REF);
    expect(error.message).toContain("snapshot()");
  });

  it("preserves the cause detail instead of erasing it (NOT_INTERACTIVE)", () => {
    const error = new BrowserInteractionError("NOT_INTERACTIVE", {
      detail: 'element is covered by <div class="cookie-banner">'
    });
    expect(error.detail).toContain("cookie-banner");
    // Detail is appended to the teaching so a single .message read has both.
    expect(error.message).toContain("cookie-banner");
    expect(error.message).toContain(INTERACTION_ERROR_TEACHING.NOT_INTERACTIVE);
  });

  it("allows overriding the message while keeping the code", () => {
    const error = new BrowserInteractionError("NAVIGATION_TIMEOUT", {
      message: "goto(https://slow.example) exceeded 15000ms"
    });
    expect(error.code).toBe("NAVIGATION_TIMEOUT");
    expect(error.message).toContain("slow.example");
  });

  it("is identifiable across realms via the guard, not instanceof", () => {
    const error = new BrowserInteractionError("DIALOG_BLOCKED");
    expect(isBrowserInteractionError(error)).toBe(true);
    expect(isBrowserInteractionError(new Error("DIALOG_BLOCKED"))).toBe(false);
    expect(isBrowserInteractionError(undefined)).toBe(false);
    // Structured-clone / JSON round-trips through the sandbox boundary lose
    // the prototype; the guard is structural so it still recognizes the wire
    // shape — this is why it exists instead of instanceof.
    const wire = JSON.parse(JSON.stringify({ ...error.toJSON() }));
    expect(isBrowserInteractionError(wire)).toBe(true);
    expect(isBrowserInteractionError({ name: "Error", code: "NOPE" })).toBe(
      false
    );
  });

  it("rejects forged shapes whose detail is not a string", () => {
    // The guard validates untrusted sandbox output: a near-miss shape with a
    // malformed detail must not narrow to BrowserInteractionErrorShape.
    const forged = {
      name: "BrowserInteractionError",
      code: "STALE_REF",
      message: "looks legitimate",
      detail: 42
    };
    expect(isBrowserInteractionError(forged)).toBe(false);
    expect(isBrowserInteractionError({ ...forged, detail: undefined })).toBe(
      true
    );
    expect(isBrowserInteractionError({ ...forged, detail: "a cause" })).toBe(
      true
    );
  });

  it("serializes to a plain shape the sandbox can rethrow", () => {
    const error = new BrowserInteractionError("STALE_REF", {
      detail: "ref e12 is from snapshot generation 3, current is 5"
    });
    const json = error.toJSON();
    expect(json).toEqual({
      name: "BrowserInteractionError",
      code: "STALE_REF",
      message: error.message,
      detail: "ref e12 is from snapshot generation 3, current is 5"
    });
  });
});

describe("teaching corpus", () => {
  it("has one fix-oriented sentence for every code", () => {
    for (const code of INTERACTION_ERROR_CODES) {
      const teaching = INTERACTION_ERROR_TEACHING[code];
      expect(teaching, `teaching for ${code}`).toBeTruthy();
      // Fix-oriented: teaching must reference a concrete next step (a verb
      // or an instruction), not merely restate the failure.
      expect(teaching.length, `teaching for ${code}`).toBeGreaterThan(20);
    }
  });

  it("teaches the escalation ladder on targeting failures", () => {
    // Misses point back down the ladder: snapshot → screenshot → HTML → CDP.
    expect(INTERACTION_ERROR_TEACHING.TARGET_NOT_FOUND).toContain("snapshot");
    expect(INTERACTION_ERROR_TEACHING.STALE_REF).toContain("snapshot");
  });

  it("teaches session mortality loudly", () => {
    const teaching = INTERACTION_ERROR_TEACHING.SESSION_RESTARTED;
    expect(teaching.toLowerCase()).toContain("lost");
    expect(teaching.toLowerCase()).toContain("verify");
  });

  it("teaches dialog handling on DIALOG_BLOCKED", () => {
    expect(INTERACTION_ERROR_TEACHING.DIALOG_BLOCKED).toContain("handleDialog");
  });
});

describe("verb descriptions (probe-friendly surface)", () => {
  it("documents every v1 verb", () => {
    const expected = [
      "goto",
      "back",
      "reload",
      "tabs",
      "openTab",
      "selectTab",
      "closeTab",
      "click",
      "fill",
      "type",
      "press",
      "select",
      "hover",
      "scroll",
      "waitFor",
      "snapshot",
      "screenshot",
      "evaluate",
      "console",
      "requests",
      "handleDialog"
    ].sort();
    expect([...VERB_NAMES].sort()).toEqual(expected);
    for (const verb of VERB_NAMES) {
      expect(VERB_DESCRIPTIONS[verb], `description for ${verb}`).toBeTruthy();
    }
  });

  it("teaches the fill-vs-type split in the descriptions themselves", () => {
    expect(VERB_DESCRIPTIONS.fill).not.toEqual(VERB_DESCRIPTIONS.type);
    expect(VERB_DESCRIPTIONS.type.toLowerCase()).toContain("keystroke");
  });
});
