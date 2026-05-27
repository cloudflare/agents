import path from "node:path";
import {
  summarizeThinkManifest,
  type ThinkConfigSeverity,
  type ThinkWorkerConfigDiagnostic
} from "../framework/config";
import type {
  ThinkFrameworkManifest,
  ThinkFrameworkRouteSurface
} from "../framework/manifest";
import { createThinkProject } from "../framework/project";

export interface InspectCommandOptions {
  root?: string;
  json?: boolean;
  routePrefix?: string;
  allowNonVirtualMain?: boolean;
}

export async function inspectCommand(
  options: InspectCommandOptions
): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd());
  const project = await createThinkProject(
    {
      routePrefix: options.routePrefix,
      allowNonVirtualMain: options.allowNonVirtualMain
    },
    root
  );

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          root,
          manifest: project.manifest,
          workerConfig: project.workerConfig,
          diagnostics: project.diagnostics,
          wranglerConfig: {
            path: project.wranglerConfig.path,
            parsed: Boolean(project.wranglerConfig.config),
            error: project.wranglerConfig.error
          }
        },
        null,
        2
      )
    );
    return;
  }

  const lines = [
    "Think inspect",
    `Root: ${root}`,
    "",
    ...summarizeThinkManifest(project.manifest),
    "",
    `Route prefix: ${project.manifest.routePrefix}`,
    `App entry: ${project.manifest.appEntrypoint ?? "none"}`,
    `Wrangler config: ${project.wranglerConfig.path ?? "not found"}`,
    "",
    "Features:",
    ...formatFeatures(project.manifest),
    "",
    "Route surfaces:",
    ...formatRouteSurfaces(project.manifest.routeSurfaces),
    "",
    "Schedules:",
    ...formatNamedFacts(project.manifest.schedules),
    "",
    "Messengers:",
    ...formatNamedFacts(project.manifest.messengers),
    "",
    "Tools:",
    ...formatNamedFacts(project.manifest.tools),
    "",
    "Platform requirements:",
    ...formatPlatformRequirements(project.manifest),
    "",
    "Expected top-level Durable Objects:",
    ...formatBindings(project.manifest.bindings),
    "",
    "Diagnostics:",
    ...formatDiagnostics(project.diagnostics)
  ];

  if (project.wranglerConfig.error) {
    lines.push("", `[warning] ${project.wranglerConfig.error}`);
  }

  console.log(lines.join("\n"));
}

function formatBindings(
  bindings: Array<{ name: string; className: string }>
): string[] {
  if (bindings.length === 0) return ["- none"];
  return bindings.map(
    (binding) => `- ${binding.name} -> class ${binding.className}`
  );
}

function formatFeatures(manifest: ThinkFrameworkManifest): string[] {
  if (manifest.features.length === 0) return ["- none"];
  return manifest.agents.flatMap((agent) => {
    if (agent.features.length === 0 && agent.env.length === 0) return [];
    return [
      `- ${agent.id}: ${
        [
          agent.features.length
            ? `features ${agent.features.join(", ")}`
            : null,
          agent.env.length ? `env ${agent.env.join(", ")}` : null
        ]
          .filter(Boolean)
          .join(" | ") || "none"
      }`
    ];
  });
}

function formatRouteSurfaces(surfaces: ThinkFrameworkRouteSurface[]): string[] {
  if (surfaces.length === 0) return ["- none"];
  return surfaces.map(
    (surface) =>
      `- ${surface.kind} ${surface.id}: ${surface.pattern}${
        surface.requiredRunWorkerFirst ? " | requires run_worker_first" : ""
      }`
  );
}

function formatNamedFacts(
  facts: Array<{ id: string; agent?: string; sourcePath?: string }>
): string[] {
  if (facts.length === 0) return ["- none"];
  return facts.map(
    (fact) =>
      `- ${fact.id}${fact.agent ? ` | agent ${fact.agent}` : ""}${
        fact.sourcePath ? ` | ${fact.sourcePath}` : ""
      }`
  );
}

function formatPlatformRequirements(
  manifest: ThinkFrameworkManifest
): string[] {
  if (manifest.platformRequirements.length === 0) return ["- none"];
  return manifest.platformRequirements.map(
    (requirement) =>
      `- ${requirement.kind} ${requirement.binding}${
        requirement.agent ? ` | agent ${requirement.agent}` : ""
      } | ${requirement.reason}`
  );
}

function formatDiagnostics(
  diagnostics: ThinkWorkerConfigDiagnostic[]
): string[] {
  if (diagnostics.length === 0) return ["- none"];
  return diagnostics.map(
    (diagnostic) =>
      `- ${severityLabel(diagnostic.severity)} [${diagnostic.code}] ${diagnostic.message}`
  );
}

function severityLabel(severity: ThinkConfigSeverity): string {
  return severity.toUpperCase();
}
