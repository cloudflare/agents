export type ThinkFrameworkFeature =
  | "skills"
  | "scheduled-tasks"
  | "messengers"
  | "tools";

export type ThinkFrameworkRouteSurfaceKind =
  | "agent"
  | "subagent"
  | "messenger"
  | "internal";

export type ThinkPlatformRequirementKind =
  | "worker_loader"
  | "workers_ai"
  | "r2"
  | "secret"
  | "env";

export interface ThinkFrameworkFeatureSource {
  feature: ThinkFrameworkFeature;
  sourcePath: string;
  signal: string;
}

export interface ThinkFrameworkAgent {
  id: string;
  className: string;
  aliases: string[];
  importPath: string;
  sourcePath: string;
  kind: "top-level" | "subagent";
  parentId?: string;
  features: ThinkFrameworkFeature[];
  featureSources?: ThinkFrameworkFeatureSource[];
  env: string[];
  exportName?: string;
  bindingName?: string;
}

export interface ThinkFrameworkBinding {
  name: string;
  className: string;
  kind: "durable-object" | "helper";
}

export interface ThinkFrameworkRoute {
  id: string;
  pattern: string;
  agent: string;
}

export interface ThinkFrameworkRouteSurface {
  id: string;
  kind: ThinkFrameworkRouteSurfaceKind;
  pattern: string;
  owner: string;
  parent?: string;
  sourcePath?: string;
  requiredRunWorkerFirst: boolean;
}

export interface ThinkFrameworkSchedule {
  id: string;
  agent: string;
  sourcePath: string;
  signal: string;
}

export interface ThinkFrameworkMessenger {
  id: string;
  agent: string;
  sourcePath: string;
  routePattern: string;
  signal: string;
}

export interface ThinkFrameworkTool {
  id: string;
  agent: string;
  sourcePath: string;
  signal: string;
}

export interface ThinkPlatformRequirement {
  kind: ThinkPlatformRequirementKind;
  binding: string;
  reason: string;
  sourcePath?: string;
  agent?: string;
}

export interface ThinkFrameworkManifest {
  root: string;
  routePrefix: string;
  agents: ThinkFrameworkAgent[];
  bindings: ThinkFrameworkBinding[];
  routes: ThinkFrameworkRoute[];
  routeSurfaces: ThinkFrameworkRouteSurface[];
  schedules: ThinkFrameworkSchedule[];
  messengers: ThinkFrameworkMessenger[];
  tools: ThinkFrameworkTool[];
  platformRequirements: ThinkPlatformRequirement[];
  env: string[];
  features: ThinkFrameworkFeature[];
  appEntrypoint?: string;
}

export interface ThinkWorkerConfigOptions {
  name?: string;
  main?: string;
  compatibilityDate?: string;
  routePrefix?: string;
}

export interface ThinkWorkerConfig extends Record<string, unknown> {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects: {
    bindings: Array<{ name: string; class_name: string }>;
  };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  assets: {
    not_found_handling: "single-page-application";
    run_worker_first: string[];
  };
}
