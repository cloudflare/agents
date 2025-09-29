import { Agent, routeAgentRequest } from "agents";
import {
  IdentityDisk,
  SqliteSource,
  type EmbeddingFn,
  type MemoryEntry,
  type RerankFn,
  type RerankResult
} from "agents/memory";
import { env } from "cloudflare:workers";
import client from "./client";

// Users are free to implement these however they want.

const embed: EmbeddingFn = async (memories: string[]) => {
  // models only allow max batch len of 100

  let embeddings: number[][] = [];
  for (let i = 0; i < memories.length; i += 100) {
    const res = (await env.AI.run("@cf/baai/bge-m3", {
      text: memories.slice(i, i + 100)
    })) as { data: number[][] };
    embeddings = embeddings.concat(res.data);
    console.log("Finished embedding batch", res.data.length);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return embeddings;
  // Getting 504 Gateway Timeout, so we'll do it sequentially
  // for (let i = 0; i < memories.length; i += 100) {
  //   batches.push(memories.slice(i, i + 100));
  // }

  // const res = await Promise.all(
  //   batches.map(async (batch) => {
  //     const res = (await env.AI.run("@cf/baai/bge-large-en-v1.5", {
  //       text: batch
  //     })) as { data: number[][] };
  //     console.log("Finished embedding batch", res.data.length);
  //     return res;
  //   })
  // );

  // return res.flatMap((r) => r.data);
};

// Reranking is optional, but makes retrevial better.
const rerank: RerankFn = async (query, results) => {
  const { response } = await env.AI.run("@cf/baai/bge-reranker-base", {
    query,
    contexts: results.map((text) => ({ text }))
  });
  return response as RerankResult[];
};

export class MemoryAgent extends Agent<Env> {
  // HNSW + memory entry map backed in SQLITE
  // Vector DBs are overkill, these are flows we can cheaply run in our Agent*
  memory!: IdentityDisk;

  async onStart() {
    this.memory = new IdentityDisk({
      embeddingFn: embed,
      rerankFn: rerank,
      vectorSource: new SqliteSource(this.ctx.storage.sql, "memory")
    });

    const start = Date.now();
    await this.memory.load();
    const end = Date.now();
    console.log("Time taken to load memory", (end - start) / 1000, "seconds");
  }

  async onRequest(request: Request) {
    if (request.method === "GET" && request.url.includes("export")) {
      const memories = [];
      for (const memory of this.memory.export()) {
        memories.push(memory);
      }
      return Response.json({ memories });
    }

    if (request.method === "POST" && request.url.includes("import")) {
      const { entries } = await request.json<{ entries: MemoryEntry[] }>();
      await this.memory.load(entries);

      return Response.json({ result: "Memories imported successfully" });
    } else if (request.method === "POST" && request.url.includes("add")) {
      const { memory } = await request.json<{ memory: MemoryEntry }>();
      await this.memory.add(memory);

      return Response.json({ result: "Memory added successfully" });
    } else if (request.method === "POST" && request.url.includes("recall")) {
      const { query, k } = await request.json<{ query: string; k?: number }>();
      const res = await this.memory.search(query, k ?? 5);
      return Response.json({ result: res });
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response(client, { headers: { "Content-Type": "text/html" } })
    );
  }
} satisfies ExportedHandler<Env>;
