import { DurableObject } from "cloudflare:workers";

export type Env = {
  TestBed: DurableObjectNamespace<TestBed>;
};

/** Real SQLite storage for the durable turn engine tests. */
export class TestBed extends DurableObject<Env> {}

export default {
  async fetch(): Promise<Response> {
    return new Response("channels turn-engine test worker");
  }
};
