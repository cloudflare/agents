/**
 * Type-level tests for Think's action descriptor surface.
 *
 * Checked by the typecheck script, not vitest.
 */

import type { PendingAction } from "@cloudflare/codemode";
import type { ReplyAttachment as BaseReplyAttachment } from "agents/chat";
import { jsonSchema } from "ai";
import { z } from "zod";
import {
  action,
  Think,
  type ActionApprovalDescriptor,
  type ReplyAttachment
} from "../think";

const zodAction = action({
  description: "Use inferred Zod input",
  inputSchema: z.object({
    count: z.number(),
    label: z.string().optional()
  }),
  execute(input) {
    const count: number = input.count;
    const label: string | undefined = input.label;
    void count;
    void label;

    // @ts-expect-error — `count` is inferred as number, not string.
    const wrong: string = input.count;
    void wrong;

    return { ok: true };
  }
});
void zodAction;

const jsonSchemaAction = action({
  description: "Use inferred AI SDK schema input",
  inputSchema: jsonSchema<{ enabled: boolean }>({
    type: "object",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"]
  }),
  execute(input) {
    const enabled: boolean = input.enabled;
    void enabled;

    // @ts-expect-error — `enabled` is inferred as boolean.
    input.enabled.toUpperCase();

    return "ok";
  }
});
void jsonSchemaAction;

const permissionInputAction = action({
  description: "Use inferred input in permission policy",
  inputSchema: z.object({ userId: z.string(), amount: z.number() }),
  permissions({ input }) {
    const userId: string = input.userId;
    void userId;

    // @ts-expect-error — `amount` is inferred as number, not string.
    const amount: string = input.amount;
    void amount;

    return ["billing:refund"];
  },
  execute(input) {
    return input.amount;
  }
});
void permissionInputAction;

const idempotencyInputAction = action({
  description: "Use inferred input in idempotency key policy",
  inputSchema: z.object({ eventId: z.string(), amount: z.number() }),
  idempotencyKey({ input }) {
    const eventId: string = input.eventId;
    void eventId;

    // @ts-expect-error — `amount` is inferred as number, not string.
    const amount: string = input.amount;
    void amount;

    return `event:${input.eventId}`;
  },
  execute(input) {
    return input.amount;
  }
});
void idempotencyInputAction;

const wrongManualInput = action({
  description: "Reject mismatched manual input annotations",
  inputSchema: z.object({ count: z.number() }),
  // @ts-expect-error — schema infers `{ count: number }`, not `{ count: string }`.
  execute(input: { count: string }) {
    return input.count;
  }
});
void wrongManualInput;

const reservedOutputSchema = action({
  description: "Accept output schema metadata",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute() {
    return { ok: true };
  }
});
void reservedOutputSchema;

const durablePauseAction = action({
  description: "A durable-pause action with a typed approval predicate",
  inputSchema: z.object({ amount: z.number() }),
  kind: "durable-pause",
  approval({ input }) {
    const amount: number = input.amount;
    void amount;

    // @ts-expect-error — `amount` is inferred as number, not string.
    const wrong: string = input.amount;
    void wrong;

    return input.amount > 100;
  },
  execute(input) {
    return input.amount;
  }
});
void durablePauseAction;

const attachReplyAction = action({
  description: "Accept common and custom reply attachment shapes",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    ctx.attachReply({ type: "voice_note" });
    ctx.attachReply({
      type: "email_draft",
      subject: "Hello",
      to: ["user@example.com"]
    });
    ctx.attachReply({ type: "card", payload: { id: 1 } });
    ctx.attachReply({ type: "custom", foo: 1 });

    // @ts-expect-error — every attachment requires a string `type`.
    ctx.attachReply({ payload: { id: 1 } });

    return "ok";
  }
});
void attachReplyAction;

const thinkAttachment: ReplyAttachment = { type: "voice_note" };
const baseAttachment: BaseReplyAttachment = thinkAttachment;
void baseAttachment;

class DescribePausedAgent extends Think {
  override describePausedExecution(
    pending: PendingAction[],
    ctx: { requestId: string; toolCallId: string }
  ): Partial<ActionApprovalDescriptor> | undefined {
    const method: string = pending[0]?.method ?? "";
    const requestId: string = ctx.requestId;
    void method;
    void requestId;

    // @ts-expect-error — risk is a closed union, "extreme" is not allowed.
    return { summary: pending[0]?.connector, risk: "extreme" };
  }
}
void DescribePausedAgent;
