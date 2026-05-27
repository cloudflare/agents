import path from "node:path";
import {
  summarizeThinkManifest,
  type ThinkConfigSeverity,
  type ThinkWorkerConfigDiagnostic
} from "../framework/config";
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
