import { env } from "cloudflare:workers";
import type { SubmissionStorageTestObject } from "./submission-store.worker";

interface TestEnv {
  SUBMISSIONS: DurableObjectNamespace<SubmissionStorageTestObject>;
}

export function submissionStoreStub(
  name: string
): DurableObjectStub<SubmissionStorageTestObject> {
  const namespace = (env as TestEnv).SUBMISSIONS;
  return namespace.get(namespace.idFromName(name));
}
