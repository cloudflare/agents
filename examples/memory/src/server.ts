import { Agent, routeAgentRequest } from "agents";
import type {
  EmbeddingFn,
  MemoryEntry,
  RerankFn,
  RerankResult
} from "agents/memory";
import { env } from "cloudflare:workers";

const embed: EmbeddingFn = async (memories: string[]) => {
  // models only allow max batch len of 100

  let embeddings: number[][] = [];
  for (let i = 0; i < memories.length; i += 100) {
    const res = (await env.AI.run("@cf/baai/bge-m3", {
      text: memories.slice(i, i + 100)
    })) as { data: number[][] };
    embeddings = embeddings.concat(res.data);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  static options = {
    embeddingFn: embed,
    rerankFn: rerank,
    hibernate: true
  };

  async chat(messages: unknown[]) {
    const disks = this.mountedDisks
      .map(({ name, description }) => {
        const size = this.disks.get(name)?.size ?? 0;
        const desc = description ?? "No description";
        return `"${name} (${desc}. Total entries: ${size})"`;
      })
      .join(", ");

    let system =
      "You are a smart assistant program. You can access Identity Disk(s) that contain information or memories. " +
      "You can search existing memories and/or add new ones. ";

    system += disks
      ? `You have been initialized with the following Identity Disk(s): ${disks}.`
      : "You haven't been given any Identity Disks yet.";

    system +=
      "Do not provide any markdown formatting. Respond in plain text, but you are free to use newlines.";

    const input = [
      {
        role: "system",
        content: system
      },
      ...messages
    ];

    const tools = [
      {
        type: "function",
        name: "search_identity_disk",
        description: "Semantic search the identity disk for a specific entry.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the identity disk to search."
            },
            query: {
              type: "string",
              description: "A query to search the identity disk for."
            },
            max_results: {
              type: "number",
              description:
                "The maximum number of results to return. Default is 20."
            }
          },
          required: ["query", "name"]
        }
      },
      {
        type: "function",
        name: "add_to_identity_disk",
        description: "Add a new memory entry to an identity disk.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the identity disk to add to."
            },
            content: {
              type: "string",
              description: "The content of the memory entry to add."
            },
            metadata: {
              type: "object",
              description: "Optional metadata for the memory entry."
            }
          },
          required: ["name", "content"]
        }
      },
      {
        type: "function",
        name: "create_identity_disk",
        description:
          "Mounts and initializes a new identity disk. Requires at least 2 memory entries to create the disk.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the identity disk to create."
            },
            description: {
              type: "string",
              description: "The description of the identity disk to create."
            },
            entries: {
              type: "array",
              items: {
                type: "object",
                description:
                  "The memory entries to initialize the disk with. 2 required.",
                properties: {
                  content: {
                    type: "string",
                    description: "The content of the memory entry to create."
                  },
                  metadata: {
                    type: "object",
                    description: "Optional metadata for the memory entry."
                  }
                },
                required: ["content"]
              }
            }
          },
          required: ["name", "entries"]
        }
      }
    ];

    let answer = "";
    while (true) {
      // biome-ignore lint/suspicious/noExplicitAny: workers AI has wrong types
      const response: any = await env.AI.run("@cf/openai/gpt-oss-120b", {
        tools,
        input
      });

      if (
        !response.output ||
        !Array.isArray(response.output) ||
        response.output.length === 0
      ) {
        console.error("Invalid response output:", response);
        throw new Error("Invalid response from AI model");
      }

      response.output.forEach((msg: unknown) => {
        input.push(msg);
      });

      // Find the last message (skip system messages)
      const msg = response.output[response.output.length - 1];

      if (!msg || !msg.type) {
        console.error("Invalid message structure:", msg);
        throw new Error("Invalid message structure from AI model");
      }

      if (msg.type === "function_call") {
        const args = JSON.parse(msg.arguments);
        const name = msg.name;
        if (name === "search_identity_disk") {
          if (!args.query) {
            input.push({
              type: "function_call_output",
              call_id: msg.call_id,
              output: "Query is required."
            });
            continue;
          }

          const disk = this.disks.get(args.name);
          if (!disk) {
            input.push({
              type: "function_call_output",
              call_id: msg.call_id,
              output: `Identity Disk ${args.name} not found.`
            });
            continue;
          }

          // Broadcast search notification to all connected clients BEFORE searching
          this.broadcast(
            JSON.stringify({
              type: "disk_search",
              diskName: args.name,
              query: args.query,
              timestamp: Date.now()
            })
          );

          const results = await disk.search(args.query, args.max_results ?? 20);
          const output =
            `Found ${results.length} results:\n\n` +
            results
              .map(
                (r) =>
                  `<entry><content>${r.content}</content>${
                    r.metadata
                      ? `<metadata>${JSON.stringify(r.metadata)}</metadata>`
                      : ""
                  }</entry>`
              )
              .join("\n");
          input.push({
            type: "function_call_output",
            call_id: msg.call_id,
            output
          });
        } else if (name === "add_to_identity_disk") {
          const disk = this.disks.get(args.name);
          if (!disk) {
            input.push({
              type: "function_call_output",
              call_id: msg.call_id,
              output: `Identity Disk ${args.name} not found.`
            });
            continue;
          }

          const entry: MemoryEntry = {
            content: args.content,
            ...(args.metadata && { metadata: args.metadata })
          };

          await disk.add(entry);

          // Broadcast add notification to all connected clients
          this.broadcast(
            JSON.stringify({
              type: "disk_add",
              diskName: args.name,
              entry,
              timestamp: Date.now()
            })
          );

          this.broadcastDisks();

          input.push({
            type: "function_call_output",
            call_id: msg.call_id,
            output: `Successfully added entry to Identity Disk "${args.name}".`
          });
        } else if (name === "create_identity_disk") {
          await this.mountDisk(args.name, args.entries, {
            description: args.description
          });

          input.push({
            type: "function_call_output",
            call_id: msg.call_id,
            output: `Successfully created Identity Disk "${args.name}".`
          });
        }
      } else if (msg.type === "message") {
        answer = msg.content[0].text;
        break;
      }
    }
    return answer;
  }

  async onRequest(request: Request) {
    if (request.method === "POST" && request.url.includes("export")) {
      const { name } = await request.json<{ name: string }>();

      if (!name) {
        return Response.json(
          { error: "Disk name is required" },
          { status: 400 }
        );
      }

      const disk = this.disks.get(name);
      if (!disk) {
        return Response.json(
          { error: `Disk "${name}" not found` },
          { status: 404 }
        );
      }

      const entries = [];
      const dumpResult = disk.dump();
      const iterable =
        dumpResult instanceof Promise ? await dumpResult : dumpResult;
      for (const item of iterable) {
        entries.push(item.entry);
      }

      return Response.json({
        name,
        description: disk.description,
        entries
      });
    } else if (request.method === "POST" && request.url.includes("import")) {
      const { name, entries, description } = await request.json<{
        name: string;
        entries: MemoryEntry[];
        description?: string;
      }>();

      if (!name) {
        return Response.json(
          { error: "Disk name is required" },
          { status: 400 }
        );
      }

      await this.mountDisk(name, entries, { description });

      return Response.json({
        result: `Disk "${name}" imported successfully with ${entries.length} entries`
      });
    } else if (request.method === "POST" && request.url.includes("delete")) {
      const { name } = await request.json<{ name: string }>();

      if (!name) {
        return Response.json(
          { error: "Disk name is required" },
          { status: 400 }
        );
      }

      await this.unmountDisk(name);
      return Response.json({ result: `Disk "${name}" deleted successfully` });
    } else if (request.method === "POST" && request.url.includes("chat")) {
      const { messages } = await request.json<{
        messages: { role: string; content: string }[];
      }>();
      const res = await this.chat(messages);
      return new Response(res);
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // First, try to route agent requests
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    // For all other requests, the Vite plugin handles serving the client assets
    // In development: Vite dev server
    // In production: built assets from dist/client
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
