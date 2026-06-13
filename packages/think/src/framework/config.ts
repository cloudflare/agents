import type {
  ThinkFrameworkManifest,
  ThinkWorkerConfig,
  ThinkWorkerConfigOptions
} from "./manifest";

export type ThinkConfigSeverity = "error" | "warning" | "info";

export interface ThinkWorkerConfigDiagnostic {
  code: string;
  severity: ThinkConfigSeverity;
  message: string;
  path?: string;
}

export interface ThinkRequiredBinding {
  kind: "worker_loader";
  binding: string;
  reason: string;
  sourcePath?: string;
}

export interface ThinkConfigMergeResult {
  config: ThinkWorkerConfig;
  diagnostics: ThinkWorkerConfigDiagnostic[];
}

export interface DiagnoseThinkWorkerConfigOptions {
  allowNonVirtualMain?: boolean;
  routeConfig?: unknown;
}

type UnknownRecord = Record<string, unknown>;

const DEFAULT_RUN_WORKER_FIRST = ["/messengers/*", "/__think/*"];

export function createThinkWorkerDefaults(
  manifest: ThinkFrameworkManifest,
  options: ThinkWorkerConfigOptions = {}
): ThinkWorkerConfig {
  const sqliteClasses = manifest.bindings
    .filter((binding) => binding.kind === "durable-object")
    .map((binding) => binding.className);

  return {
    name: options.name ?? "think-app",
    main: options.main ?? "virtual:think/entry",
    compatibility_date: options.compatibilityDate ?? "2026-06-11",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: manifest.bindings.map((binding) => ({
        name: binding.name,
        class_name: binding.className
      }))
    },
    migrations: sqliteClasses.length
      ? [{ tag: "v1", new_sqlite_classes: sqliteClasses }]
      : [],
    assets: {
      not_found_handling: "single-page-application",
      run_worker_first: [
        `${manifest.routePrefix}/*`,
        ...DEFAULT_RUN_WORKER_FIRST
      ]
    }
  };
}

export function createThinkWorkerConfig(
  manifest: ThinkFrameworkManifest,
  options: ThinkWorkerConfigOptions = {}
): ThinkWorkerConfig {
  return mergeThinkWorkerConfig(
    {},
    createThinkWorkerDefaults(manifest, options)
  ).config;
}

export function mergeThinkWorkerConfig(
  userConfig: Partial<ThinkWorkerConfig> | UnknownRecord,
  inferredConfig: ThinkWorkerConfig
): ThinkConfigMergeResult {
  const diagnostics: ThinkWorkerConfigDiagnostic[] = [];
  const user = cloneRecord(userConfig);
  const inferred = cloneRecord(inferredConfig) as ThinkWorkerConfig;
  const config = {
    ...inferred,
    ...user
  } as ThinkWorkerConfig;

  config.compatibility_flags = mergeStringArrays(
    asStringArray(inferred.compatibility_flags),
    asStringArray(user.compatibility_flags)
  );

  config.assets = {
    ...asRecord(inferred.assets),
    ...asRecord(user.assets),
    run_worker_first: mergeStringArrays(
      asStringArray(inferred.assets?.run_worker_first),
      asStringArray(asRecord(user.assets).run_worker_first)
    )
  } as ThinkWorkerConfig["assets"];

  config.durable_objects = {
    ...asRecord(inferred.durable_objects),
    ...asRecord(user.durable_objects),
    bindings: mergeDurableObjectBindings(
      inferred.durable_objects?.bindings,
      asRecord(user.durable_objects).bindings,
      diagnostics
    )
  } as ThinkWorkerConfig["durable_objects"];

  config.migrations = mergeMigrations(
    inferred.migrations,
    user.migrations,
    diagnostics
  );

  return { config, diagnostics };
}

export function diagnoseThinkManifest(
  manifest: ThinkFrameworkManifest
): ThinkWorkerConfigDiagnostic[] {
  return [
    ...findDuplicates(
      manifest.agents.map((agent) => agent.id),
      "duplicate-agent-id",
      "Agent convention paths must be unique."
    ),
    ...findDuplicates(
      manifest.agents.map((agent) => agent.className),
      "duplicate-generated-agent-name",
      "Generated agent class names must be unique."
    ),
    ...findDuplicates(
      manifest.routes.map((route) => route.id),
      "duplicate-route-id",
      "Generated route ids must be unique."
    ),
    ...findDuplicates(
      manifest.routeSurfaces.map((surface) => surface.id),
      "duplicate-route-surface-id",
      "Generated route surface ids must be unique."
    ),
    ...findUnsupportedNestedSubAgents(manifest),
    ...findOrphanSubAgents(manifest)
  ];
}

export function diagnoseThinkWorkerConfig(
  manifest: ThinkFrameworkManifest,
  userConfig: unknown,
  options: DiagnoseThinkWorkerConfigOptions = {}
): ThinkWorkerConfigDiagnostic[] {
  const diagnostics = [...diagnoseThinkManifest(manifest)];
  const config = asRecord(userConfig);
  const bindings = readBindings(config);
  const migrations = readMigrationClasses(config);

  if (
    !options.allowNonVirtualMain &&
    manifest.agents.length > 0 &&
    typeof config.main === "string" &&
    config.main !== "virtual:think/entry"
  ) {
    diagnostics.push({
      code: "unexpected-worker-main",
      severity: "error",
      path: "main",
      message:
        `This project has Think agents, but wrangler.jsonc main is "${config.main}". ` +
        `Set main to "virtual:think/entry" so the Think Vite plugin can generate the Worker entry, ` +
        `or enable the advanced non-virtual main escape hatch in the Think plugin options.`
    });
  }

  for (const binding of manifest.bindings) {
    const agent = manifest.agents.find(
      (candidate) => candidate.className === binding.className
    );
    const agentLabel = agent ? `agent "${agent.id}"` : "a discovered agent";
    const matchingClass = bindings.some(
      (candidate) => candidate.class_name === binding.className
    );
    if (!matchingClass) {
      diagnostics.push({
        code: "missing-durable-object-class",
        severity: "error",
        path: "durable_objects.bindings",
        message:
          `Missing Durable Object binding for ${agentLabel}. ` +
          `Think generates class "${binding.className}" from "${agent?.sourcePath ?? binding.className}". ` +
          `Add a durable_objects binding whose class_name is "${binding.className}".`
      });
    }

    if (!migrations.has(binding.className)) {
      diagnostics.push({
        code: "missing-migration-class",
        severity: "error",
        path: "migrations",
        message:
          `Missing Durable Object migration for ${agentLabel}. ` +
          `Add generated class "${binding.className}" to new_sqlite_classes.`
      });
    }
  }

  for (const required of inferRequiredBindings(manifest)) {
    if (
      required.kind === "worker_loader" &&
      !hasWorkerLoader(config, required.binding)
    ) {
      diagnostics.push({
        code: "missing-worker-loader-binding",
        severity: "error",
        path: "worker_loaders",
        message:
          `Missing worker_loaders binding "${required.binding}". ${required.reason} ` +
          `Add { "binding": "${required.binding}" } to worker_loaders, or remove the feature that needs dynamic Workers.`
      });
    }
  }

  const routeConfig = asRecord(options.routeConfig ?? config);
  const runWorkerFirst = asStringArray(
    asRecord(routeConfig.assets).run_worker_first
  );
  const expectedAgentsRoute = `${manifest.routePrefix}/*`;
  if (
    manifest.routes.length > 0 &&
    runWorkerFirst.length > 0 &&
    !runWorkerFirst.includes(expectedAgentsRoute)
  ) {
    diagnostics.push({
      code: "custom-agent-routing",
      severity: manifest.appEntrypoint ? "info" : "warning",
      path: "assets.run_worker_first",
      message:
        `This Worker has Think agents but assets.run_worker_first does not include "${expectedAgentsRoute}". ` +
        `That is valid for auth-gated custom routing, but direct ${manifest.routePrefix}/* routes will not reach Think. ` +
        `Add "${expectedAgentsRoute}" or route requests explicitly with the injected Think router.`
    });
  }

  const uncoveredRouteSurfaces = manifest.routeSurfaces.filter(
    (surface) =>
      surface.requiredRunWorkerFirst &&
      surface.kind !== "agent" &&
      surface.kind !== "internal" &&
      runWorkerFirst.length > 0 &&
      !isRouteSurfaceCovered(surface.pattern, runWorkerFirst)
  );
  if (uncoveredRouteSurfaces.length > 0) {
    diagnostics.push({
      code: "custom-think-route-surface-routing",
      severity: manifest.appEntrypoint ? "info" : "warning",
      path: "assets.run_worker_first",
      message:
        `Some Think-owned routes will not reach the Worker with the current assets.run_worker_first setting: ` +
        `${uncoveredRouteSurfaces.map((surface) => surface.pattern).join(", ")}.`
    });
  }

  return diagnostics;
}

export function summarizeThinkManifest(
  manifest: ThinkFrameworkManifest
): string[] {
  if (manifest.agents.length === 0) return ["No Think agents discovered."];

  const topLevel = manifest.agents.filter(
    (agent) => agent.kind === "top-level"
  );
  const subagents = manifest.agents.filter(
    (agent) => agent.kind === "subagent"
  );
  const lines = [
    `Discovered ${manifest.agents.length} Think agent${manifest.agents.length === 1 ? "" : "s"} ` +
      `(${topLevel.length} top-level, ${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}).`
  ];

  for (const agent of manifest.agents) {
    const route =
      agent.kind === "top-level" ? `${manifest.routePrefix}/${agent.id}` : null;
    lines.push(
      [
        `- ${agent.id}`,
        `class ${agent.className}`,
        agent.kind === "subagent" ? `parent ${agent.parentId}` : route,
        agent.features.length ? `features ${agent.features.join(", ")}` : null
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }

  return lines;
}

export function inferRequiredBindings(
  manifest: ThinkFrameworkManifest
): ThinkRequiredBinding[] {
  const requirements = manifest.platformRequirements.filter(
    (requirement) => requirement.kind === "worker_loader"
  );
  if (requirements.length === 0 && manifest.features.includes("skills")) {
    requirements.push({
      kind: "worker_loader",
      binding: "LOADER",
      reason: "Agents with colocated skills need a Worker Loader binding."
    });
  }
  const seen = new Set<string>();
  return requirements.flatMap((requirement) => {
    if (seen.has(requirement.binding)) return [];
    seen.add(requirement.binding);
    return [
      {
        kind: "worker_loader" as const,
        binding: requirement.binding,
        reason: requirement.reason,
        sourcePath: requirement.sourcePath
      }
    ];
  });
}

function mergeDurableObjectBindings(
  inferredValue: unknown,
  userValue: unknown,
  diagnostics: ThinkWorkerConfigDiagnostic[]
): Array<{ name: string; class_name: string }> {
  const merged: Array<{ name: string; class_name: string }> = [];
  const byName = new Map<string, { name: string; class_name: string }>();
  const byClass = new Map<string, { name: string; class_name: string }>();

  for (const binding of [
    ...readBindingArray(userValue),
    ...readBindingArray(inferredValue)
  ]) {
    const existing = byName.get(binding.name);
    if (existing && existing.class_name !== binding.class_name) {
      diagnostics.push({
        code: "durable-object-binding-conflict",
        severity: "error",
        path: "durable_objects.bindings",
        message:
          `Durable Object binding "${binding.name}" maps to both ` +
          `"${existing.class_name}" and "${binding.class_name}".`
      });
      continue;
    }
    if (byClass.has(binding.class_name)) continue;
    if (!existing) {
      byName.set(binding.name, binding);
      byClass.set(binding.class_name, binding);
      merged.push(binding);
    }
  }

  return merged;
}

function mergeMigrations(
  inferredValue: unknown,
  userValue: unknown,
  diagnostics: ThinkWorkerConfigDiagnostic[]
): Array<{ tag: string; new_sqlite_classes: string[] }> {
  const inferred = readMigrationArray(inferredValue);
  const user = readMigrationArray(userValue);
  const inferredClasses = inferred.flatMap(
    (migration) => migration.new_sqlite_classes
  );
  const userClasses = user.flatMap((migration) => migration.new_sqlite_classes);
  const userClassSet = new Set(userClasses);
  const missingInferredClasses = inferredClasses.filter(
    (className) => !userClassSet.has(className)
  );

  const duplicateClasses = duplicateValues(userClasses);
  for (const className of duplicateClasses) {
    diagnostics.push({
      code: "duplicate-migration-class",
      severity: "warning",
      path: "migrations",
      message: `Migration class "${className}" is listed more than once.`
    });
  }

  if (user.length === 0) return inferred;
  if (missingInferredClasses.length === 0) return user;

  return [
    ...user,
    {
      tag: nextThinkMigrationTag(user),
      new_sqlite_classes: missingInferredClasses
    }
  ];
}

function readBindings(
  config: UnknownRecord
): Array<{ name: string; class_name: string }> {
  return readBindingArray(asRecord(config.durable_objects).bindings);
}

function readBindingArray(
  value: unknown
): Array<{ name: string; class_name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (
      typeof record.name !== "string" ||
      typeof record.class_name !== "string"
    ) {
      return [];
    }
    return [{ name: record.name, class_name: record.class_name }];
  });
}

function readMigrationClasses(config: UnknownRecord): Set<string> {
  return new Set(
    readMigrationArray(config.migrations).flatMap(
      (migration) => migration.new_sqlite_classes
    )
  );
}

function readMigrationArray(
  value: unknown
): Array<{ tag: string; new_sqlite_classes: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const classes = asStringArray(record.new_sqlite_classes);
    if (typeof record.tag !== "string" || classes.length === 0) return [];
    return [{ tag: record.tag, new_sqlite_classes: classes }];
  });
}

function nextThinkMigrationTag(
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>
): string {
  const existing = new Set(migrations.map((migration) => migration.tag));
  let index = 1;
  while (existing.has(`think-generated-v${index}`)) index++;
  return `think-generated-v${index}`;
}

function hasWorkerLoader(config: UnknownRecord, binding: string): boolean {
  const loaders = config.worker_loaders;
  return (
    Array.isArray(loaders) &&
    loaders.some((entry) => asRecord(entry).binding === binding)
  );
}

function isRouteSurfaceCovered(
  pattern: string,
  runWorkerFirst: string[]
): boolean {
  return runWorkerFirst.some((entry) => {
    if (entry === pattern) return true;
    if (!entry.endsWith("/*")) return false;
    const prefix = entry.slice(0, -1);
    return pattern.startsWith(prefix);
  });
}

function findDuplicates(
  values: string[],
  code: string,
  message: string
): ThinkWorkerConfigDiagnostic[] {
  return duplicateValues(values).map((value) => ({
    code,
    severity: "error" as const,
    message: `${message} Duplicate value: "${value}".`
  }));
}

function findOrphanSubAgents(
  manifest: ThinkFrameworkManifest
): ThinkWorkerConfigDiagnostic[] {
  const topLevelIds = new Set(
    manifest.agents
      .filter((agent) => agent.kind === "top-level")
      .map((agent) => agent.id)
  );
  return manifest.agents
    .filter(
      (agent) =>
        agent.kind === "subagent" &&
        agent.id.split("/").length <= 2 &&
        (agent.parentId === undefined || !topLevelIds.has(agent.parentId))
    )
    .map((agent) => ({
      code: "orphan-subagent",
      severity: "error" as const,
      path: agent.sourcePath,
      message:
        `Subagent "${agent.id}" has no top-level parent agent at "${agent.parentId ?? "<missing>"}". ` +
        `Add a parent agent module or move the subagent under an existing agents/<parent>/agents folder.`
    }));
}

function findUnsupportedNestedSubAgents(
  manifest: ThinkFrameworkManifest
): ThinkWorkerConfigDiagnostic[] {
  return manifest.agents
    .filter(
      (agent) => agent.kind === "subagent" && agent.id.split("/").length > 2
    )
    .map((agent) => ({
      code: "unsupported-nested-subagent",
      severity: "error" as const,
      path: agent.sourcePath,
      message:
        `Nested subagents are not supported yet: "${agent.id}". ` +
        `Think currently supports top-level agents and one subagent layer; move this agent under agents/<parent>/agents/ or make it top-level.`
    }));
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function mergeStringArrays(...values: unknown[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of values.flatMap(asStringArray)) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

function cloneRecord(value: unknown): UnknownRecord {
  return JSON.parse(JSON.stringify(asRecord(value))) as UnknownRecord;
}
