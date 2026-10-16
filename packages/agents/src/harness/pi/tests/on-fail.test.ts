import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Run a failing prompt with a follow-up queued behind it. */
async function failWithFollowUp(
  object:
    | DurableObjectStub<import("./on-fail-fixture").PiOnFailResumeTestObject>
    | DurableObjectStub<import("./on-fail-fixture").PiOnFailAbortTestObject>
) {
  const failing = await object.submit("fail");
  const followUp = await object.submit("after the failure");
  await object.release();
  expect(await object.settledWithin(failing.operationId, 10_000)).toMatchObject(
    { status: "unanswered", reason: "model_error" }
  );
  return object.settledWithin(followUp.operationId, 10_000);
}

describe("PiHarness onFail", () => {
  it("runs inputs queued behind a failed run by default", async () => {
    const object = env.PI_ON_FAIL_RESUME_TEST.getByName(crypto.randomUUID());
    expect(await failWithFollowUp(object)).toMatchObject({
      status: "done",
      text: "echo: after the failure"
    });
  });

  it("withdraws inputs queued behind a failed run with onFail: abort", async () => {
    const object = env.PI_ON_FAIL_ABORT_TEST.getByName(crypto.randomUUID());
    expect(await failWithFollowUp(object)).toMatchObject({
      status: "unanswered",
      reason: "aborted"
    });
  });
});
