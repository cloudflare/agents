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
  SettledSubmissionRecord
} from "@earendil-works/pi-durable";
import { expectTypeOf } from "vitest";
import type {
  PiOperationResult,
  PiSubmitOptions,
  PiWhenBusy
} from "../harness/pi";

expectTypeOf<PiWhenBusy>().toEqualTypeOf<
  NonNullable<InputSubmissionDraft["whenBusy"]>
>();

// Every input option pi takes is exposed, apart from the ones PiHarness
// fills in itself: `type` and `content` from the input, `requestId` from
// `operationId`.
expectTypeOf<
  Exclude<keyof InputSubmissionDraft, "type" | "content" | "requestId">
>().toEqualTypeOf<Exclude<keyof PiSubmitOptions, "session" | "operationId">>();

expectTypeOf<PiOperationResult["status"]>().toEqualTypeOf<
  SettledSubmissionRecord["status"]
>();
