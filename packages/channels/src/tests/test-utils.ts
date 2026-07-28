import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createSubmissionRouter } from "../submission-endpoint";
import { SubmissionStore } from "../storage/submission-store";
import type { SubmissionInput } from "../submissions";
import type { SubmissionStorageTestObject } from "./submission-store.worker";

interface TestEnv {
  SUBMISSIONS: DurableObjectNamespace<SubmissionStorageTestObject>;
}

export async function acceptanceResponse(
  storeName: string,
  request: Request
): Promise<Response> {
  const stub = submissionStoreStub(storeName);
  const router = createSubmissionRouter({
    acceptor() {
      return {
        accept(input) {
          return runInDurableObject(stub, (_instance, state) =>
            new SubmissionStore(state.storage).accept(input)
          );
        }
      };
    }
  });
  return router.request(request);
}

export function exampleSubmissionInput(
  overrides: Partial<SubmissionInput> = {}
): SubmissionInput {
  return {
    idempotencyKey: "tenant-acme:slack:T123:event:Ev01ABC",
    agentTarget: "support-agent/acme",
    payload: {
      type: "message",
      text: "Where is order 1234?"
    },
    source: {
      type: "slack-webhook",
      id: "Ev01ABC"
    },
    conversationHint: "slack:T123:C456:thread:1712345678.000100",
    ...overrides
  };
}

export function submissionRequest(
  body: string,
  options: { contentType?: string | null; method?: string } = {}
): Request {
  const method = options.method ?? "POST";
  const contentType =
    options.contentType === undefined
      ? "application/json"
      : options.contentType;
  return new Request("https://channels.example/", {
    method,
    headers: contentType === null ? undefined : { "content-type": contentType },
    ...(method === "GET" || method === "HEAD" ? {} : { body })
  });
}

export function submissionStoreStub(
  name: string
): DurableObjectStub<SubmissionStorageTestObject> {
  const namespace = (env as TestEnv).SUBMISSIONS;
  return namespace.get(namespace.idFromName(name));
}
