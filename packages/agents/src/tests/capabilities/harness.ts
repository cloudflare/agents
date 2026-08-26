import { DurableObject } from "cloudflare:workers";

/**
 * Bare Durable Object for capability tests that need real storage and real
 * Lifecycle services but construct their capabilities per test (for example
 * to vary constructor options). Registered in the workers test project;
 * drive it through `withCapabilityHarness` in `../shared/capability-harness`.
 */
export class CapabilityHarnessObject extends DurableObject<Cloudflare.Env> {}
