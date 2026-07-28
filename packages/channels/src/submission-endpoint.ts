import { Hono } from "hono";
import type { Context, Env } from "hono";
import { z } from "zod";
import { jsonValueSchema, nonEmptyStringSchema } from "./schema-utils";
import type { SubmissionAcceptance, SubmissionInput } from "./submissions";

const submissionInputSchema: z.ZodType<SubmissionInput> = z.strictObject({
  idempotencyKey: nonEmptyStringSchema,
  agentTarget: nonEmptyStringSchema,
  payload: jsonValueSchema,
  source: z.strictObject({
    type: nonEmptyStringSchema,
    id: nonEmptyStringSchema.optional()
  }),
  conversationHint: nonEmptyStringSchema.optional()
});

/** Durable acceptance capability required by the HTTP submission endpoint. */
export interface SubmissionAcceptor {
  /** Atomically accept canonical adapter input. */
  accept(
    input: SubmissionInput
  ): SubmissionAcceptance | Promise<SubmissionAcceptance>;
}

/** Configuration for a host-mounted submission acceptance router. */
export interface SubmissionRouterOptions<E extends Env> {
  /**
   * Resolve the durable acceptor selected by authenticated host context.
   * Every retry of one idempotency key must resolve to the same durable store.
   */
  acceptor(
    context: Context<E>
  ): SubmissionAcceptor | Promise<SubmissionAcceptor>;
}

/**
 * Create the HTTP boundary for canonical submission acceptance.
 *
 * The host authenticates and normalizes adapter input before this boundary and
 * chooses where to mount the returned router. A successful response confirms
 * durable acceptance only; it does not mean an agent received or ran the turn.
 */
export function createSubmissionRouter<E extends Env>(
  options: SubmissionRouterOptions<E>
): Hono<E> {
  const router = new Hono<E>();

  router.post("/", async (context) => {
    const contentType = context.req.header("content-type");
    const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
      return context.json({ error: "unsupported_media_type" }, 415);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_json" }, 400);
    }

    const parsed = submissionInputSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: "invalid_submission",
          message: z.prettifyError(parsed.error)
        },
        422
      );
    }

    let acceptance: SubmissionAcceptance;
    try {
      const acceptor = await options.acceptor(context);
      acceptance = await acceptor.accept(parsed.data);
    } catch {
      return context.json({ error: "acceptance_indeterminate" }, 500);
    }

    switch (acceptance.outcome) {
      case "accepted":
        return context.json(acceptance, 202);
      case "duplicate":
        return context.json(acceptance, 200);
      case "conflict":
        return context.json(acceptance, 409);
    }
  });

  router.all("/", (context) => {
    context.header("Allow", "POST");
    return context.json({ error: "method_not_allowed" }, 405);
  });

  return router;
}
