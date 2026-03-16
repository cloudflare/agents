import { createMcpHandler } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import spec from "./openapi-spec.json";

const pets = [
  { id: "1", name: "Buddy", species: "dog", age: 3 },
  { id: "2", name: "Whiskers", species: "cat", age: 5 },
  { id: "3", name: "Tweety", species: "bird", age: 1 }
];

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const server = openApiMcpServer({
      spec,
      executor,
      name: "petstore",
      // This is where you call your API. Runs on the host — auth, base URL,
      // headers are all yours. The sandbox never sees tokens or secrets.
      request: async (opts) => {
        if (opts.method === "GET" && opts.path === "/pets") {
          let result = [...pets];
          if (opts.query?.species) {
            result = result.filter(
              (p) => p.species === String(opts.query!.species)
            );
          }
          if (opts.query?.limit) {
            result = result.slice(0, Number(opts.query.limit));
          }
          return { success: true, data: result };
        }

        if (opts.method === "GET" && opts.path.startsWith("/pets/")) {
          const id = opts.path.split("/").pop();
          const pet = pets.find((p) => p.id === id);
          if (!pet) return { success: false, error: "Not found" };
          return { success: true, data: pet };
        }

        if (opts.method === "GET" && opts.path === "/owners") {
          return {
            success: true,
            data: [
              { id: "1", name: "Alice", petIds: ["1"] },
              { id: "2", name: "Bob", petIds: ["2", "3"] }
            ]
          };
        }

        return {
          success: false,
          error: `Unknown route: ${opts.method} ${opts.path}`
        };
      }
    });

    return createMcpHandler(server)(request, env, ctx);
  }
};
