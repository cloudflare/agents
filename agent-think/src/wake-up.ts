import { DurableObject } from "cloudflare:workers";
import { tool } from "ai";
import { z } from "zod";

const REGISTRATION_KEY = "registration";
const COMPLETED_EVENTS_KEY = "completed-events";
const COMPLETED_EVENT_HISTORY_LIMIT = 64;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/#-]{0,255}$/;

export interface WakeUpRegistration {
  id: string;
  session: string;
  description: string;
  registeredAt: number;
}

interface StoredWakeUpRegistration extends WakeUpRegistration {
  claimedEventId?: string;
}

export interface WakeUpEvent {
  id: string;
  eventId: string;
  result: string;
  installationToken?: string;
}

export interface WakeUpResult {
  woken: boolean;
  session?: string;
  submissionId?: string;
  accepted?: boolean;
  reason?: "not_registered" | "duplicate_event" | "delivery_in_progress";
}

export function validateWakeUpId(id: string): void {
  if (!ACTION_ID_PATTERN.test(id)) {
    throw new Error(
      "wake-up id must be 1-256 characters and use only letters, numbers, :, ., _, /, #, or -"
    );
  }
}

function validateWakeUpEventId(eventId: string): void {
  if (!eventId || eventId.length > 256) {
    throw new Error("wake-up eventId must be 1-256 characters");
  }
}

export function validateWakeUpEvent(event: WakeUpEvent): void {
  validateWakeUpId(event.id);
  validateWakeUpEventId(event.eventId);
  if (!event.result || event.result.length > 64 * 1024) {
    throw new Error("wake-up result must be 1-65536 characters");
  }
}

export function wakeUpSubmissionKey(id: string, eventId: string): string {
  validateWakeUpId(id);
  validateWakeUpEventId(eventId);
  return `wake-up:${id}:event:${eventId}`;
}

/**
 * One Durable Object per external action id. The object stores only the Think
 * session that asked to be resumed; event producers never choose a session.
 */
export class WakeUpRegistry extends DurableObject<Env> {
  async register(registration: WakeUpRegistration): Promise<
    | { registered: true; registration: WakeUpRegistration }
    | {
        registered: false;
        reason: "owned_by_another_session" | "delivery_in_progress";
        session: string;
      }
  > {
    validateWakeUpId(registration.id);
    if (!registration.session || registration.session.length > 256) {
      throw new Error("wake-up session must be 1-256 characters");
    }
    if (!registration.description || registration.description.length > 500) {
      throw new Error("wake-up description must be 1-500 characters");
    }

    const existing =
      await this.ctx.storage.get<StoredWakeUpRegistration>(REGISTRATION_KEY);
    if (existing && existing.session !== registration.session) {
      return {
        registered: false,
        reason: "owned_by_another_session",
        session: existing.session
      };
    }
    if (existing?.claimedEventId) {
      return {
        registered: false,
        reason: "delivery_in_progress",
        session: existing.session
      };
    }
    await this.ctx.storage.put(REGISTRATION_KEY, registration);
    return { registered: true, registration };
  }

  async getRegistration(): Promise<WakeUpRegistration | null> {
    const registration =
      await this.ctx.storage.get<StoredWakeUpRegistration>(REGISTRATION_KEY);
    if (!registration) return null;
    const { claimedEventId: _, ...publicRegistration } = registration;
    return publicRegistration;
  }

  async claim(eventId: string): Promise<
    | { claimed: true; registration: WakeUpRegistration }
    | {
        claimed: false;
        reason: "not_registered" | "duplicate_event" | "delivery_in_progress";
      }
  > {
    validateWakeUpEventId(eventId);
    return this.ctx.storage.transaction(async (txn) => {
      const completed = (await txn.get<string[]>(COMPLETED_EVENTS_KEY)) ?? [];
      if (completed.includes(eventId)) {
        return { claimed: false, reason: "duplicate_event" };
      }

      const registration =
        await txn.get<StoredWakeUpRegistration>(REGISTRATION_KEY);
      if (!registration) {
        return { claimed: false, reason: "not_registered" };
      }
      if (registration.claimedEventId) {
        return { claimed: false, reason: "delivery_in_progress" };
      }

      await txn.put(REGISTRATION_KEY, {
        ...registration,
        claimedEventId: eventId
      } satisfies StoredWakeUpRegistration);
      const { claimedEventId: _, ...publicRegistration } = registration;
      return { claimed: true, registration: publicRegistration };
    });
  }

  async complete(eventId: string, session: string): Promise<boolean> {
    validateWakeUpEventId(eventId);
    return this.ctx.storage.transaction(async (txn) => {
      const registration =
        await txn.get<StoredWakeUpRegistration>(REGISTRATION_KEY);
      if (
        !registration ||
        registration.session !== session ||
        registration.claimedEventId !== eventId
      ) {
        return false;
      }
      const completed = (await txn.get<string[]>(COMPLETED_EVENTS_KEY)) ?? [];
      await txn.put(
        COMPLETED_EVENTS_KEY,
        [eventId, ...completed.filter((id) => id !== eventId)].slice(
          0,
          COMPLETED_EVENT_HISTORY_LIMIT
        )
      );
      await txn.delete(REGISTRATION_KEY);
      return true;
    });
  }

  async release(eventId: string, session: string): Promise<boolean> {
    validateWakeUpEventId(eventId);
    return this.ctx.storage.transaction(async (txn) => {
      const registration =
        await txn.get<StoredWakeUpRegistration>(REGISTRATION_KEY);
      if (
        !registration ||
        registration.session !== session ||
        registration.claimedEventId !== eventId
      ) {
        return false;
      }
      const { claimedEventId: _, ...publicRegistration } = registration;
      await txn.put(REGISTRATION_KEY, publicRegistration);
      return true;
    });
  }
}

export function wakeUpRegistry(
  env: Pick<Env, "WakeUpRegistry">,
  id: string
): DurableObjectStub<WakeUpRegistry> {
  validateWakeUpId(id);
  return env.WakeUpRegistry.get(env.WakeUpRegistry.idFromName(id));
}

export function createWakeUpTool(options: {
  env: Pick<Env, "WakeUpRegistry">;
  session: string;
}) {
  return tool({
    description:
      "Register a one-shot external action that should wake this Think session " +
      "when it finishes. The caller that completes the action reports its result " +
      "through AgentThink.wakeUp; that result is submitted as a new user message " +
      "on this same thread. Call this only after the external action exists, use " +
      "a stable domain id both sides can derive, then end the current turn instead " +
      "of polling, sleeping, or waiting.",
    inputSchema: z.object({
      id: z
        .string()
        .regex(ACTION_ID_PATTERN)
        .describe(
          "Stable external action id, for example github:workflow-run:owner/repo:pr:123:workflow:CI"
        ),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe("Short description of the event this session is waiting for")
    }),
    execute: async ({ id, description }) => {
      const result = await wakeUpRegistry(options.env, id).register({
        id,
        session: options.session,
        description,
        registeredAt: Date.now()
      });
      if (!result.registered) {
        return {
          status: "error",
          id,
          message:
            result.reason === "delivery_in_progress"
              ? "This wake-up id is currently delivering an event. Wait for that delivery to finish; do not replace it or invent another id."
              : "This wake-up id is already registered by another session. Use the external action's correct stable id; do not invent a random replacement."
        };
      }
      return {
        status: "registered",
        id,
        message:
          "Wake-up registered. End this turn now; the external result will arrive as a new user message on this thread."
      };
    }
  });
}
