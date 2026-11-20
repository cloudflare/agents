/**
 * PiHarness's contract with pi-durable: the pi types `PiHarness` re-declares
 * or passes through. Assigning ours to pi's only checks that ours is a
 * subset, so a value pi adds slips by. These check equality both ways. When
 * a pi upgrade fails one, decide whether to expose the change, then update
 * the type, its docs, and this file.
 *
 * Unions `PiHarness` branches on are guarded where it branches, with
 * exhaustive switches in `harness/pi/harness.ts`.
 */
import type {
  InputSubmissionDraft,
  SettledSubmissionRecord,
  SubmissionDraft
} from "@earendil-works/pi-durable";
import { expectTypeOf } from "vitest";
import type {
  PiContinueOptions,
  PiOnAbort,
  PiOperationResult,
  PiSubmitOptions,
  PiWhenBusy,
  PiWhenIdle
} from "../harness/pi";

expectTypeOf<PiWhenBusy>().toEqualTypeOf<
  NonNullable<InputSubmissionDraft["whenBusy"]>
>();

expectTypeOf<PiWhenIdle>().toEqualTypeOf<
  NonNullable<InputSubmissionDraft["whenIdle"]>
>();

expectTypeOf<PiOnAbort>().toEqualTypeOf<
  NonNullable<InputSubmissionDraft["onAbort"]>
>();

// Every input option pi takes is exposed, apart from the ones PiHarness
// fills in itself: `type` and `content` from the input, `requestId` from
// `operationId`.
expectTypeOf<
  Exclude<keyof InputSubmissionDraft, "type" | "content" | "requestId">
>().toEqualTypeOf<Exclude<keyof PiSubmitOptions, "session" | "operationId">>();

// The same for a continue: every option pi takes on one, apart from `type`
// and `requestId`.
type ContinueSubmissionDraft = Extract<SubmissionDraft, { type: "continue" }>;
expectTypeOf<
  Exclude<
    {
      [
        K in keyof ContinueSubmissionDraft
      ]-?: undefined extends ContinueSubmissionDraft[K]
        ? [ContinueSubmissionDraft[K]] extends [undefined]
          ? never
          : K
        : K;
    }[keyof ContinueSubmissionDraft],
    "type" | "requestId"
  >
>().toEqualTypeOf<Exclude<keyof PiContinueOptions, "operationId">>();

expectTypeOf<PiOperationResult["status"]>().toEqualTypeOf<
  SettledSubmissionRecord["status"]
>();
