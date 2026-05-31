import type {
  ThinkFrameworkAgent,
  ThinkFrameworkFeatureSource,
  ThinkFrameworkFeature,
  ThinkFrameworkManifest
} from "./manifest";

export interface DiscoverThinkAppOptions {
  root?: string;
  routePrefix?: string;
  files: Record<string, string>;
}

interface AgentCandidate {
  sourcePath: string;
  importPath: string;
  colocatedPaths: string[];
  id: string;
  className: string;
  aliases: string[];
  segments: string[];
  kind: "top-level" | "subagent";
  parentId?: string;
}

export function discoverThinkApp(
  options: DiscoverThinkAppOptions
): ThinkFrameworkManifest {
  const root = normalizeRoot(options.root ?? ".");
  const routePrefix = normalizeRoutePrefix(options.routePrefix ?? "/agents");
  const files = normalizeFiles(options.files);
  const candidates = discoverAgentCandidates(files);
  const agents = candidates.map(discoverAgent);

  const topLevelAgents = agents.filter((agent) => agent.kind === "top-level");
  const bindings = topLevelAgents.map((agent) => ({
    name: agent.className,
    className: agent.className,
    kind: "durable-object" as const
  }));

  const routes = topLevelAgents.map((agent) => ({
    id: agent.id,
    pattern: `${routePrefix}/${agent.id}/*`,
    agent: agent.className
  }));
  const routeSurfaces = discoverRouteSurfaces({
    routePrefix,
    agents
  });
  const platformRequirements =
    discoverDeterministicPlatformRequirements(agents);

  return {
    root,
    routePrefix,
    agents,
    bindings,
    routes,
    routeSurfaces,
    schedules: [],
    messengers: [],
    tools: [],
    platformRequirements,
    env: [],
    features: sortedFeatures(agents.flatMap((agent) => agent.features)),
    appEntrypoint: files["src/server.ts"] ? "src/server.ts" : undefined
  };
}

function normalizeRoot(root: string): string {
  return root.replace(/\/+$/, "") || ".";
}

function normalizeFiles(files: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    normalized[normalizePath(path)] = content;
  }
  return normalized;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function discoverAgentCandidates(
  files: Record<string, string>
): AgentCandidate[] {
  const paths = Object.keys(files).sort();
  return paths
    .filter((path) => isAgentModulePath(path) && !path.endsWith(".d.ts"))
    .map((sourcePath): AgentCandidate => {
      const topology = agentTopologyFromPath(sourcePath);
      const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
      const colocatedPrefix =
        sourcePath.endsWith("/agent.ts") ||
        sourcePath.endsWith("/agent.tsx") ||
        sourcePath.endsWith("/agent.js") ||
        sourcePath.endsWith("/agent.mjs")
          ? `${directory}/`
          : `${sourcePath.replace(/\.(?:ts|tsx|js|mjs)$/, "")}/`;
      return {
        sourcePath,
        importPath: rootImportPath(sourcePath),
        ...topology,
        colocatedPaths: colocatedPrefix
          ? paths.filter(
              (path) => path.startsWith(colocatedPrefix) && path !== sourcePath
            )
          : []
      };
    });
}

function isAgentModulePath(path: string): boolean {
  const parts = path.split("/");
  const file = parts.at(-1);
  if (!file || !/\.(?:ts|tsx|js|mjs)$/.test(file)) return false;
  if (parts[0] !== "agents") return false;
  if (file.startsWith(".") || file.endsWith(".d.ts")) return false;

  const withoutExtension = file.replace(/\.(?:ts|tsx|js|mjs)$/, "");
  const agentIndexes = parts
    .map((part, index) => (part === "agents" ? index : -1))
    .filter((index) => index >= 0);
  const lastAgentsIndex = agentIndexes.at(-1);
  if (lastAgentsIndex === undefined) return false;

  const relative = parts.slice(lastAgentsIndex + 1);
  return (
    relative.length === 1 ||
    (relative.length === 2 && withoutExtension === "agent")
  );
}

function rootImportPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function discoverAgent(candidate: AgentCandidate): ThinkFrameworkAgent {
  const featureSources = discoverConventionFeatureSources(candidate);
  return {
    id: candidate.id,
    className: candidate.className,
    aliases: candidate.aliases,
    importPath: candidate.importPath,
    sourcePath: candidate.sourcePath,
    kind: candidate.kind,
    parentId: candidate.parentId,
    features: sortedFeatures(featureSources.map((source) => source.feature)),
    featureSources,
    env: []
  };
}

function agentTopologyFromPath(path: string): {
  id: string;
  className: string;
  aliases: string[];
  segments: string[];
  kind: "top-level" | "subagent";
  parentId?: string;
} {
  const segments = agentSegmentsFromPath(path);
  const id = segments.join("/");
  const kind = segments.length === 1 ? "top-level" : "subagent";
  const parentId =
    kind === "subagent" ? segments.slice(0, -1).join("/") : undefined;
  const generatedPath = segments.map(pascalCase).join("_");
  const className =
    kind === "top-level"
      ? `ThinkAgent_${generatedPath}`
      : `ThinkSubAgent_${generatedPath}`;
  const localSegment = segments.at(-1) ?? "agent";
  const aliases = [
    id,
    localSegment,
    pascalCase(localSegment),
    `${kind === "top-level" ? "ThinkAgent" : "ThinkSubAgent"}_${generatedPath}`
  ];
  return {
    id,
    className,
    aliases: [...new Set(aliases)],
    segments,
    kind,
    parentId
  };
}

function agentSegmentsFromPath(path: string): string[] {
  const parts = path.split("/");
  const segments: string[] = [];
  let index = 0;
  while (index < parts.length) {
    if (parts[index] !== "agents") {
      index++;
      continue;
    }
    const name = parts[index + 1];
    const maybeAgentFile = parts[index + 2];
    if (!name) break;
    if (maybeAgentFile?.startsWith("agent.")) {
      segments.push(name);
      index += 3;
      continue;
    }
    segments.push(name.replace(/\.(?:ts|tsx|js|mjs)$/, ""));
    index += 2;
  }
  return segments.map(kebabCase);
}

function sortedFeatures(
  features: ThinkFrameworkFeature[]
): ThinkFrameworkFeature[] {
  const order: ThinkFrameworkFeature[] = [
    "skills",
    "scheduled-tasks",
    "messengers",
    "tools"
  ];
  const present = new Set(features);
  return order.filter((feature) => present.has(feature));
}

function discoverConventionFeatureSources(
  candidate: AgentCandidate
): ThinkFrameworkFeatureSource[] {
  const skillsPrefix = `${sourceRootDirectory(candidate.sourcePath)}/skills/`;
  const skillConventionPaths = candidate.colocatedPaths.filter((path) =>
    path.startsWith(skillsPrefix)
  );
  return skillConventionPaths.map((path) => ({
    feature: "skills",
    sourcePath: path,
    signal: "colocated-skills"
  }));
}

function sourceRootDirectory(sourcePath: string): string {
  const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
  return sourcePath.match(/\/agent\.(?:ts|tsx|js|mjs)$/)
    ? directory
    : sourcePath.replace(/\.(?:ts|tsx|js|mjs)$/, "");
}

function discoverRouteSurfaces(options: {
  routePrefix: string;
  agents: ThinkFrameworkAgent[];
}): ThinkFrameworkManifest["routeSurfaces"] {
  const surfaces: ThinkFrameworkManifest["routeSurfaces"] = [];
  const topLevelIds = new Set(
    options.agents
      .filter((agent) => agent.kind === "top-level")
      .map((agent) => agent.id)
  );

  for (const agent of options.agents) {
    if (agent.kind === "top-level") {
      surfaces.push({
        id: `agent:${agent.id}`,
        kind: "agent",
        pattern: `${options.routePrefix}/${agent.id}/*`,
        owner: agent.id,
        sourcePath: agent.sourcePath,
        requiredRunWorkerFirst: true
      });
      continue;
    }
    if (
      agent.id.split("/").length !== 2 ||
      !agent.parentId ||
      !topLevelIds.has(agent.parentId)
    ) {
      continue;
    }
    const localId = agent.id.split("/").at(-1) ?? agent.id;
    surfaces.push({
      id: `subagent:${agent.id}`,
      kind: "subagent",
      pattern: `${options.routePrefix}/${agent.parentId}/{name}/sub/${localId}/{subName}`,
      owner: agent.id,
      parent: agent.parentId,
      sourcePath: agent.sourcePath,
      requiredRunWorkerFirst: true
    });
  }

  surfaces.push({
    id: "internal:think",
    kind: "internal",
    pattern: "/__think/*",
    owner: "think",
    requiredRunWorkerFirst: true
  });

  return surfaces;
}

function discoverDeterministicPlatformRequirements(
  agents: ThinkFrameworkAgent[]
): ThinkFrameworkManifest["platformRequirements"] {
  const skillsAgent = agents.find((agent) => agent.features.includes("skills"));
  if (!skillsAgent) return [];
  return [
    {
      kind: "worker_loader",
      binding: "LOADER",
      reason: "Agents with colocated skills need a Worker Loader binding.",
      sourcePath: skillsAgent.sourcePath,
      agent: skillsAgent.id
    }
  ];
}

function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function normalizeRoutePrefix(prefix: string): string {
  const normalized = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/agents" : normalized;
}
