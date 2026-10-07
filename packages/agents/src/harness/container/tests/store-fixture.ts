import { DurableObject } from "cloudflare:workers";

/** A bare object whose SQLite database the store tests use. */
export class HarnessStoreTestObject extends DurableObject<Cloudflare.Env> {}
