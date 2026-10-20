/**
 * Tests for the AI-free JSON Schema → TypeScript conversion.
 * These functions have zero dependency on ai/zod and work with plain
 * JSON Schema objects — the kind you get from MCP tool definitions
 * or OpenAPI specs.
 *
 * Each test uses toBe with the exact expected output so these tests
 * double as documentation for the output format.
 */
import { describe, it, expect } from "vitest";
import {
  generateTypesFromJsonSchema,
  jsonSchemaToType
} from "../json-schema-types";

// ---------------------------------------------------------------------------
// jsonSchemaToType — single schema → type declaration
// ---------------------------------------------------------------------------

describe("jsonSchemaToType", () => {
  it("converts a simple object with required and optional fields", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" }
        },
        required: ["name"]
      },
      "UserInput"
    );

    expect(result).toBe(
      [
        "type UserInput = {",
        "    name: string;",
        "    age?: number;",
        "}"
      ].join("\n")
    );
  });

  it("converts string enums", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "inactive", "pending"] }
        }
      },
      "StatusInput"
    );

    expect(result).toBe(
      [
        "type StatusInput = {",
        '    status?: "active" | "inactive" | "pending";',
        "}"
      ].join("\n")
    );
  });

  it("converts nested objects", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              zip: { type: "string" }
            },
            required: ["street"]
          }
        }
      },
      "PersonInput"
    );

    expect(result).toBe(
      [
        "type PersonInput = {",
        "    address?: {",
        "        street: string;",
        "        zip?: string;",
        "    };",
        "}"
      ].join("\n")
    );
  });

  it("converts arrays with typed items", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          scores: { type: "array", items: { type: "number" } }
        }
      },
      "DataInput"
    );

    expect(result).toBe(
      [
        "type DataInput = {",
        "    tags?: string[];",
        "    scores?: number[];",
        "}"
      ].join("\n")
    );
  });

  it("converts a bare string schema", () => {
    expect(jsonSchemaToType({ type: "string" }, "NameInput")).toBe(
      "type NameInput = string"
    );
  });

  it("converts an empty object schema to Record<string, unknown>", () => {
    expect(jsonSchemaToType({ type: "object" }, "EmptyInput")).toBe(
      "type EmptyInput = Record<string, unknown>"
    );
  });
});

// ---------------------------------------------------------------------------
// generateTypesFromJsonSchema — MCP-style tool descriptors
// ---------------------------------------------------------------------------

describe("generateTypesFromJsonSchema", () => {
  it("generates types for a single tool with descriptions", () => {
    const result = generateTypesFromJsonSchema({
      getWeather: {
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
            units: {
              type: "string",
              enum: ["celsius", "fahrenheit"]
            }
          },
          required: ["city"]
        }
      }
    });

    expect(result).toBe(
      [
        "type GetWeatherInput = {",
        "    /** City name */",
        "    city: string;",
        '    units?: "celsius" | "fahrenheit";',
        "}",
        "type GetWeatherOutput = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Get weather for a city",
        "\t * @param input.city - City name",
        "\t */",
        "\tgetWeather: (input: GetWeatherInput) => Promise<GetWeatherOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("generates types for multiple tools with name sanitization", () => {
    const result = generateTypesFromJsonSchema({
      search: {
        description: "Search for items",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          },
          required: ["query"]
        }
      },
      "get-item": {
        description: "Get an item by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" }
          },
          required: ["id"]
        }
      }
    });

    expect(result).toBe(
      [
        "type SearchInput = {",
        "    query: string;",
        "    limit?: number;",
        "}",
        "type SearchOutput = unknown",
        "type GetItemInput = {",
        "    id: string;",
        "}",
        "type GetItemOutput = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Search for items",
        "\t */",
        "\tsearch: (input: SearchInput) => Promise<SearchOutput>;",
        "",
        "\t/**",
        "\t * Get an item by ID",
        "\t */",
        "\tget_item: (input: GetItemInput) => Promise<GetItemOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("generates typed output schemas when provided", () => {
    const result = generateTypesFromJsonSchema({
      getUser: {
        description: "Get a user",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        },
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" }
          },
          required: ["name", "email"]
        }
      }
    });

    expect(result).toBe(
      [
        "type GetUserInput = {",
        "    id: string;",
        "}",
        "type GetUserOutput = {",
        "    name: string;",
        "    email: string;",
        "}",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Get a user",
        "\t */",
        "\tgetUser: (input: GetUserInput) => Promise<GetUserOutput>;",
        "}"
      ].join("\n")
    );
  });

  it("handles an empty tool set", () => {
    expect(generateTypesFromJsonSchema({})).toBe("declare const codemode: {}");
  });

  it("generates types from MCP-style tool definitions", () => {
    const result = generateTypesFromJsonSchema({
      create_issue: {
        description: "Create a GitHub issue",
        inputSchema: {
          type: "object" as const,
          properties: {
            owner: {
              type: "string" as const,
              description: "Repository owner"
            },
            repo: {
              type: "string" as const,
              description: "Repository name"
            },
            title: {
              type: "string" as const,
              description: "Issue title"
            },
            body: {
              type: "string" as const,
              description: "Issue body"
            },
            labels: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Labels to add"
            }
          },
          required: ["owner", "repo", "title"] as string[]
        }
      },
      list_issues: {
        description: "List issues in a repository",
        inputSchema: {
          type: "object" as const,
          properties: {
            owner: { type: "string" as const },
            repo: { type: "string" as const },
            state: {
              type: "string" as const,
              enum: ["open", "closed", "all"]
            },
            per_page: { type: "number" as const }
          },
          required: ["owner", "repo"] as string[]
        }
      }
    });

    expect(result).toBe(
      [
        "type CreateIssueInput = {",
        "    /** Repository owner */",
        "    owner: string;",
        "    /** Repository name */",
        "    repo: string;",
        "    /** Issue title */",
        "    title: string;",
        "    /** Issue body */",
        "    body?: string;",
        "    /** Labels to add */",
        "    labels?: string[];",
        "}",
        "type CreateIssueOutput = unknown",
        "type ListIssuesInput = {",
        "    owner: string;",
        "    repo: string;",
        '    state?: "open" | "closed" | "all";',
        "    per_page?: number;",
        "}",
        "type ListIssuesOutput = unknown",
        "",
        "declare const codemode: {",
        "\t/**",
        "\t * Create a GitHub issue",
        "\t * @param input.owner - Repository owner",
        "\t * @param input.repo - Repository name",
        "\t * @param input.title - Issue title",
        "\t * @param input.body - Issue body",
        "\t * @param input.labels - Labels to add",
        "\t */",
        "\tcreate_issue: (input: CreateIssueInput) => Promise<CreateIssueOutput>;",
        "",
        "\t/**",
        "\t * List issues in a repository",
        "\t */",
        "\tlist_issues: (input: ListIssuesInput) => Promise<ListIssuesOutput>;",
        "}"
      ].join("\n")
    );
  });
});
