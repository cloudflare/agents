import { createMcpHandler } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";

/**
 * A sample OpenAPI spec for a fake "Petstore" API.
 * In a real app, you'd fetch this from a URL or load from R2.
 */
const SAMPLE_SPEC = {
  openapi: "3.0.0",
  info: { title: "Petstore", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        summary: "List all pets",
        tags: ["pets"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", maximum: 100 },
            description: "How many items to return"
          },
          {
            name: "species",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["dog", "cat", "bird"] },
            description: "Filter by species"
          }
        ],
        responses: {
          "200": {
            description: "A list of pets",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Pet" }
                }
              }
            }
          }
        }
      },
      post: {
        summary: "Create a pet",
        tags: ["pets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewPet" }
            }
          }
        },
        responses: {
          "201": {
            description: "The created pet",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" }
              }
            }
          }
        }
      }
    },
    "/pets/{petId}": {
      get: {
        summary: "Get a pet by ID",
        tags: ["pets"],
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        ],
        responses: {
          "200": {
            description: "A pet",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" }
              }
            }
          }
        }
      },
      delete: {
        summary: "Delete a pet",
        tags: ["pets"],
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        ],
        responses: {
          "204": { description: "Pet deleted" }
        }
      }
    },
    "/owners": {
      get: {
        summary: "List all owners",
        tags: ["owners"],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer" }
          }
        ]
      }
    }
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          species: { type: "string", enum: ["dog", "cat", "bird"] },
          age: { type: "integer" }
        },
        required: ["id", "name", "species"]
      },
      NewPet: {
        type: "object",
        properties: {
          name: { type: "string" },
          species: { type: "string", enum: ["dog", "cat", "bird"] },
          age: { type: "integer" }
        },
        required: ["name", "species"]
      }
    }
  }
};

/**
 * Fake in-memory pet store for the demo.
 */
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
      spec: SAMPLE_SPEC,
      executor,
      name: "petstore",
      request: async (opts) => {
        // This runs on the HOST side — full access to env, secrets, etc.
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

        if (
          opts.method === "GET" &&
          opts.path.startsWith("/pets/")
        ) {
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

        return { success: false, error: `Unknown route: ${opts.method} ${opts.path}` };
      }
    });

    return createMcpHandler(server)(request, env, ctx);
  }
};
