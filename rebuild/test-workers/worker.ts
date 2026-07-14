/**
 * Test worker for the workerd suite (audit 27 §9). W1 replaces
 * `ScaffoldAgent` with real test agent classes wired through the Cloudflare
 * adapters; for the scaffold it only proves the rig reaches a SQLite-backed
 * Durable Object.
 */
import { DurableObject } from "cloudflare:workers";

export class ScaffoldAgent extends DurableObject {
  override async fetch(): Promise<Response> {
    return new Response("scaffold");
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("rebuild test worker");
  },
};
