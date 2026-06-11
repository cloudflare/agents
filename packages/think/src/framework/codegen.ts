import { createThinkWorkerDefaults } from "./config";
import type { ThinkFrameworkManifest } from "./manifest";

export function generateThinkAgentsModule(
  manifest: ThinkFrameworkManifest
): string {
  const imports = manifest.agents
    .map((agent, index) => {
      return `import * as AgentModule${index} from ${JSON.stringify(agent.importPath)};`;
    })
    .join("\n");

  const agents = manifest.agents
    .map((agent, index) => {
      return [
        `const AgentInfo${index} = __resolveThinkAgentModule(AgentModule${index}, ${JSON.stringify(agent.sourcePath)}, ${JSON.stringify(agent.className)});`,
        `const Agent${index} = AgentInfo${index}.agent;`
      ].join("\n");
    })
    .join("\n");

  const exports = manifest.agents
    .map((agent, index) => {
      return `export { Agent${index} as ${agent.className} };`;
    })
    .join("\n");

  const registry = `export const thinkAgentRegistry = [
${manifest.agents
  .map((agent, index) => {
    return `  { id: ${JSON.stringify(agent.id)}, className: ${JSON.stringify(agent.className)}, kind: ${JSON.stringify(agent.kind)}, parentId: ${JSON.stringify(agent.parentId)}, aliases: ${JSON.stringify(agent.aliases)}, exportName: AgentInfo${index}.exportName, sourcePath: ${JSON.stringify(agent.sourcePath)} }`;
  })
  .join(",\n")}
];`;

  return [imports, "", runtimeHelpers, "", agents, exports, registry, ""]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function generateThinkManifestModule(
  manifest: ThinkFrameworkManifest
): string {
  return `export default ${JSON.stringify(manifest, null, 2)};`;
}

export function generateThinkConfigModule(
  manifest: ThinkFrameworkManifest
): string {
  return `export default ${JSON.stringify(createThinkWorkerDefaults(manifest), null, 2)};`;
}

export function generateThinkRouterModule(
  manifest: ThinkFrameworkManifest
): string {
  return [
    `import { createThinkRouter } from "@cloudflare/think/server-entry";`,
    `import thinkManifest from "virtual:think/manifest";`,
    `export { buildThinkAgentPath, createThinkRouter, parseThinkAgentPath, routeThinkRequest, resolveThinkAgentName, resolveThinkSubAgentName } from "@cloudflare/think/server-entry";`,
    `export const thinkRouter = createThinkRouter({ routePrefix: ${JSON.stringify(manifest.routePrefix)}, manifest: thinkManifest });`,
    ""
  ].join("\n");
}

export function generateThinkServerEntryModule(): string {
  return [
    `export { buildThinkAgentPath, createThinkRouter, createThinkWorkerEntry, parseThinkAgentPath, routeThinkRequest } from "@cloudflare/think/server-entry";`,
    ""
  ].join("\n");
}

export function generateThinkEntry(manifest: ThinkFrameworkManifest): string {
  const appImport = manifest.appEntrypoint
    ? `import appEntrypoint from ${JSON.stringify(`/${manifest.appEntrypoint}`)};`
    : `const appEntrypoint = null;`;

  return [
    `export * from "virtual:think/agents";`,
    // The codemode runtime facet class must be exported from the worker
    // entry so tools built on createCodemodeRuntime (execute, browser) can
    // spawn it via ctx.exports.
    `export { CodemodeRuntime } from "@cloudflare/think/server-entry";`,
    `import { thinkRouter } from "virtual:think/router";`,
    appImport,
    "",
    "export default {",
    "  async fetch(request, env, ctx) {",
    "    if (appEntrypoint?.fetch) {",
    "      const response = await appEntrypoint.fetch(request, env, ctx, { router: thinkRouter });",
    "      if (response) return response;",
    "    }",
    `    return (await thinkRouter.route(request, env, ctx)) ?? new Response('Not found', { status: 404 });`,
    "  }",
    "};",
    ""
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

const runtimeHelpers = `
const THINK_AGENT_DEFINITION = Symbol.for("cloudflare.think.agent.definition");

function __resolveThinkAgentModule(module, sourcePath, className) {
  const candidates = [];
  if ("default" in module) candidates.push(["default", module.default]);
  for (const [name, value] of Object.entries(module)) {
    if (name !== "default") candidates.push([name, value]);
  }

  const valid = candidates.filter(([, value]) => __isThinkAgentExport(value));
  if (valid.length === 0) {
    const declarativeLike = candidates.find(([, value]) => __looksLikeInvalidThinkAgentDefinition(value));
    const hint = declarativeLike
      ? "A declarative agent export must be created with agent({ ... }) from @cloudflare/think/framework."
      : "If this file only contains helper code, move it outside the /agents convention tree.";
    throw new Error(
      \`Invalid Think agent module: \${sourcePath}\\n\\n\` +
        \`This file matches the /agents convention, but it does not export a Think agent.\\n\` +
        \`Export a class that extends Agent/Think, or export default agent({ ... }).\\n\` +
        hint
    );
  }

  const selected = valid.find(([name]) => name === "default") ?? (valid.length === 1 ? valid[0] : null);
  if (!selected) {
    throw new Error(
      \`Invalid Think agent module: \${sourcePath}\\n\\n\` +
        \`This file exports multiple agent classes. Export one default agent or move helper classes outside /agents.\\n\` +
        \`Only one Durable Object class can be generated for each convention path.\`
    );
  }

  const value = selected[1];
  const resolved = __isThinkAgentDefinition(value)
    ? value.__toThinkClass(className)
    : value;
  try {
    Object.defineProperty(resolved, "name", { value: className });
  } catch {
    // Best effort: class names are configurable for normal class declarations.
  }
  return { agent: resolved, exportName: selected[0] };
}

function __isThinkAgentExport(value) {
  return __isThinkAgentDefinition(value) || __isAgentClass(value);
}

function __isThinkAgentDefinition(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value[THINK_AGENT_DEFINITION] === true ||
        value.kind === "think-agent-definition") &&
      typeof value.__toThinkClass === "function"
  );
}

function __looksLikeInvalidThinkAgentDefinition(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.kind === "think-agent-definition" &&
      typeof value.__toThinkClass !== "function"
  );
}

function __isAgentClass(value) {
  return Boolean(
    typeof value === "function" &&
      value.prototype &&
      typeof value.prototype.fetch === "function"
  );
}
`.trim();
