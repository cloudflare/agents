/**
 * Performance & Memory profiler: jsonSchema() vs fromJSONSchema()
 *
 * Run with: npx tsx packages/agents/src/tests/mcp/profile-schemas.ts
 */

import { jsonSchema } from "ai";
import { fromJSONSchema } from "zod/v4";

// Schemas to test
const simpleSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    age: { type: "number" as const },
  },
  required: ["name"],
};

const complexSchema = {
  type: "object" as const,
  properties: {
    query: { type: "string" as const, description: "Search query" },
    filters: {
      type: "object" as const,
      properties: {
        category: { type: "string" as const },
        minPrice: { type: "number" as const },
        maxPrice: { type: "number" as const },
        tags: { type: "array" as const, items: { type: "string" as const } },
        inStock: { type: "boolean" as const },
      },
    },
    pagination: {
      type: "object" as const,
      properties: {
        page: { type: "integer" as const },
        limit: { type: "integer" as const },
        sortBy: { type: "string" as const, enum: ["relevance", "price", "date"] },
        sortOrder: { type: "string" as const, enum: ["asc", "desc"] },
      },
    },
  },
  required: ["query"],
};

const deeplyNestedSchema = {
  type: "object" as const,
  properties: {
    l1: {
      type: "object" as const,
      properties: {
        l2: {
          type: "object" as const,
          properties: {
            l3: {
              type: "object" as const,
              properties: {
                l4: {
                  type: "object" as const,
                  properties: {
                    l5: { type: "object" as const, properties: { value: { type: "string" as const } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatNs(ns: bigint): string {
  const us = Number(ns) / 1000;
  if (us < 1000) return `${us.toFixed(2)} µs`;
  return `${(us / 1000).toFixed(2)} ms`;
}

interface BenchResult {
  name: string;
  avgTime: bigint;
  minTime: bigint;
  maxTime: bigint;
  memoryDelta: number;
  iterations: number;
}

function benchmark(name: string, fn: () => void, iterations: number = 10000): BenchResult {
  // Warmup
  for (let i = 0; i < 100; i++) fn();

  // Force GC if available
  if (global.gc) global.gc();

  const memBefore = process.memoryUsage().heapUsed;
  const times: bigint[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    times.push(end - start);
  }

  const memAfter = process.memoryUsage().heapUsed;

  times.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const sum = times.reduce((a, b) => a + b, 0n);
  const avg = sum / BigInt(iterations);

  return {
    name,
    avgTime: avg,
    minTime: times[0],
    maxTime: times[times.length - 1],
    memoryDelta: memAfter - memBefore,
    iterations,
  };
}

function printResult(result: BenchResult) {
  console.log(`  ${result.name}:`);
  console.log(`    Avg: ${formatNs(result.avgTime)} | Min: ${formatNs(result.minTime)} | Max: ${formatNs(result.maxTime)}`);
  console.log(`    Memory delta: ${formatBytes(result.memoryDelta)} (over ${result.iterations} iterations)`);
}

function compareResults(a: BenchResult, b: BenchResult) {
  const ratio = Number(a.avgTime) / Number(b.avgTime);
  const faster = ratio > 1 ? b.name : a.name;
  const multiplier = ratio > 1 ? ratio : 1 / ratio;
  console.log(`  → ${faster} is ${multiplier.toFixed(2)}x faster`);
}

console.log("=".repeat(70));
console.log("Schema Performance & Memory Profiler");
console.log("=".repeat(70));
console.log();

// Simple Schema
console.log("📊 SIMPLE SCHEMA (2 properties)");
console.log("-".repeat(40));
const simpleFromJson = benchmark("fromJSONSchema", () => fromJSONSchema(simpleSchema));
const simpleJsonSchema = benchmark("jsonSchema", () => jsonSchema(simpleSchema));
printResult(simpleFromJson);
printResult(simpleJsonSchema);
compareResults(simpleFromJson, simpleJsonSchema);
console.log();

// Complex Schema
console.log("📊 COMPLEX MCP SCHEMA (nested, enums, arrays)");
console.log("-".repeat(40));
const complexFromJson = benchmark("fromJSONSchema", () => fromJSONSchema(complexSchema));
const complexJsonSchema = benchmark("jsonSchema", () => jsonSchema(complexSchema));
printResult(complexFromJson);
printResult(complexJsonSchema);
compareResults(complexFromJson, complexJsonSchema);
console.log();

// Deeply Nested
console.log("📊 DEEPLY NESTED SCHEMA (5 levels)");
console.log("-".repeat(40));
const deepFromJson = benchmark("fromJSONSchema", () => fromJSONSchema(deeplyNestedSchema));
const deepJsonSchema = benchmark("jsonSchema", () => jsonSchema(deeplyNestedSchema));
printResult(deepFromJson);
printResult(deepJsonSchema);
compareResults(deepFromJson, deepJsonSchema);
console.log();

// Validation (only fromJSONSchema)
console.log("📊 VALIDATION PERFORMANCE (fromJSONSchema only)");
console.log("-".repeat(40));
const complexZod = fromJSONSchema(complexSchema);
const testData = {
  query: "test",
  filters: { category: "electronics", minPrice: 10, tags: ["new"] },
  pagination: { page: 1, limit: 20, sortBy: "price", sortOrder: "asc" },
};
const validationResult = benchmark("Complex schema validation", () => complexZod.safeParse(testData));
printResult(validationResult);
console.log();

// Memory overhead per schema
console.log("📊 MEMORY OVERHEAD (single schema instance)");
console.log("-".repeat(40));
if (global.gc) global.gc();
const mem1 = process.memoryUsage().heapUsed;
const _s1 = fromJSONSchema(complexSchema);
const mem2 = process.memoryUsage().heapUsed;
const _s2 = jsonSchema(complexSchema);
const mem3 = process.memoryUsage().heapUsed;
console.log(`  fromJSONSchema: ~${formatBytes(mem2 - mem1)}`);
console.log(`  jsonSchema:     ~${formatBytes(mem3 - mem2)}`);
console.log();

console.log("=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));
console.log(`
• jsonSchema() is a thin wrapper - just stores the schema object
• fromJSONSchema() parses and creates a full Zod schema with validators
• fromJSONSchema() is slower but provides real validation + _zod property
• For MCP tools with codemode, fromJSONSchema() is required for type generation
`);
