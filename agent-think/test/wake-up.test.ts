import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  validateWakeUpEvent,
  validateWakeUpId,
  wakeUpRegistry,
  wakeUpSubmissionKey
} from "../src/wake-up";

describe("wake-up registry", () => {
  it("builds a stable submission idempotency key", () => {
    expect(
      wakeUpSubmissionKey(
        "github:workflow-run:cloudflare/cloudflare-docs:pr:32100:workflow:CI",
        "run:987:attempt:1"
      )
    ).toBe(
      "wake-up:github:workflow-run:cloudflare/cloudflare-docs:pr:32100:workflow:CI:event:run:987:attempt:1"
    );
  });

  it("rejects invalid action ids and event payloads", () => {
    expect(() => validateWakeUpId("contains spaces")).toThrow(
      "wake-up id must be"
    );
    expect(() => validateWakeUpId("x".repeat(257))).toThrow(
      "wake-up id must be"
    );
    expect(() =>
      validateWakeUpEvent({ id: "valid", eventId: "", result: "done" })
    ).toThrow("wake-up eventId must be");
    expect(() =>
      validateWakeUpEvent({ id: "valid", eventId: "event", result: "" })
    ).toThrow("wake-up result must be");
  });

  it("atomically claims one session and rejects old event redeliveries", async () => {
    const id = `test:wake:${crypto.randomUUID()}`;
    const registry = wakeUpRegistry(env, id);
    const registration = {
      id,
      session: "cloudflare-agents-1861",
      description: "Wait for docs CI",
      registeredAt: 123
    };

    expect(await registry.register(registration)).toMatchObject({
      registered: true,
      registration
    });
    expect(await registry.getRegistration()).toEqual(registration);
    expect(
      await registry.register({ ...registration, session: "another-session" })
    ).toMatchObject({
      registered: false,
      reason: "owned_by_another_session",
      session: registration.session
    });

    expect(await registry.claim("run:1")).toMatchObject({
      claimed: true,
      registration
    });
    expect(await registry.claim("run:2")).toEqual({
      claimed: false,
      reason: "delivery_in_progress"
    });
    expect(await registry.release("run:1", registration.session)).toBe(true);
    expect(await registry.claim("run:1")).toMatchObject({ claimed: true });
    expect(await registry.complete("run:1", registration.session)).toBe(true);
    expect(await registry.getRegistration()).toBeNull();

    // A retry starts another external attempt under the same stable action id.
    expect(
      await registry.register({ ...registration, registeredAt: 456 })
    ).toMatchObject({
      registered: true
    });
    // Redelivery of the old event is remembered and cannot consume the new wait.
    expect(await registry.claim("run:1")).toEqual({
      claimed: false,
      reason: "duplicate_event"
    });
    expect(await registry.getRegistration()).toMatchObject({
      registeredAt: 456
    });
    expect(await registry.claim("run:2")).toMatchObject({ claimed: true });
  });
});
