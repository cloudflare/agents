import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSubmissionRouter } from "../submission-endpoint";
import { SubmissionStore } from "../storage/submission-store";
import {
  acceptanceResponse,
  exampleSubmissionInput,
  submissionRequest,
  submissionStoreStub
} from "./test-utils";

describe("submission acceptance endpoint", () => {
  it("acknowledges only after the submission is durably accepted", async () => {
    // Arrange
    const storeName = `endpoint-${crypto.randomUUID()}`;
    const stub = submissionStoreStub(storeName);
    const input = exampleSubmissionInput();

    // Act
    const response = await acceptanceResponse(
      storeName,
      submissionRequest(JSON.stringify(input))
    );
    const acknowledgement = (await response.json()) as {
      outcome: string;
      submissionId: string;
    };
    const stored = await runInDurableObject(stub, (_instance, state) =>
      new SubmissionStore(state.storage).get(acknowledgement.submissionId)
    );

    // Assert
    expect(response.status).toBe(202);
    expect(acknowledgement.outcome).toBe("accepted");
    expect(stored).toMatchObject({ envelope: input, state: "pending" });
  });

  it("returns the original submission for an equivalent duplicate", async () => {
    // Arrange
    const storeName = `endpoint-${crypto.randomUUID()}`;
    const body = JSON.stringify(exampleSubmissionInput());

    // Act
    const first = await acceptanceResponse(storeName, submissionRequest(body));
    const duplicate = await acceptanceResponse(
      storeName,
      submissionRequest(body)
    );
    const firstBody = (await first.json()) as { submissionId: string };
    const duplicateBody = (await duplicate.json()) as {
      outcome: string;
      submissionId: string;
    };

    // Assert
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toEqual({
      outcome: "duplicate",
      submissionId: firstBody.submissionId
    });
  });

  it("returns a conflict without exposing the original submission", async () => {
    // Arrange
    const storeName = `endpoint-${crypto.randomUUID()}`;
    const input = exampleSubmissionInput();

    // Act
    await acceptanceResponse(
      storeName,
      submissionRequest(JSON.stringify(input))
    );
    const conflict = await acceptanceResponse(
      storeName,
      submissionRequest(
        JSON.stringify({ ...input, agentTarget: "another-agent" })
      )
    );

    // Assert
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ outcome: "conflict" });
  });

  it.each([
    {
      name: "an unsupported method",
      request: () => submissionRequest("", { method: "GET" }),
      status: 405,
      error: "method_not_allowed"
    },
    {
      name: "a non-JSON content type",
      request: () => submissionRequest("text", { contentType: "text/plain" }),
      status: 415,
      error: "unsupported_media_type"
    },
    {
      name: "malformed JSON",
      request: () => submissionRequest("{"),
      status: 400,
      error: "invalid_json"
    },
    {
      name: "an invalid canonical envelope",
      request: () =>
        submissionRequest(
          JSON.stringify({ ...exampleSubmissionInput(), schemaVersion: 1 })
        ),
      status: 422,
      error: "invalid_submission"
    }
  ])("rejects $name", async ({ request, status, error }) => {
    // Arrange
    const storeName = `endpoint-${crypto.randomUUID()}`;

    // Act
    const response = await acceptanceResponse(storeName, request());
    const body = (await response.json()) as { error: string };

    // Assert
    expect(response.status).toBe(status);
    expect(body.error).toBe(error);
    if (status === 405) {
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("reports an indeterminate outcome without exposing internal errors", async () => {
    // Arrange
    const request = submissionRequest(JSON.stringify(exampleSubmissionInput()));
    const router = createSubmissionRouter({
      acceptor() {
        return {
          accept() {
            throw new Error("sensitive database details");
          }
        };
      }
    });

    // Act
    const response = await router.request(request);

    // Assert
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "acceptance_indeterminate"
    });
  });
});
