export type ThinkFrameworkFeature =
  | "skills"
  | "scheduled-tasks"
  | "messengers"
  | "tools";

export type ThinkAgentDeclarationKind = "class" | "declarative";

export interface ThinkFrameworkAgent {
  id: string;
  className: string;
  aliases: string[];
  importPath: string;
  sourcePath: string;
  kind: "top-level" | "subagent";
  parentId?: string;
  features: ThinkFrameworkFeature[];
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

export interface ThinkFrameworkManifest {
  root: string;
  routePrefix: string;
  agents: ThinkFrameworkAgent[];
  bindings: ThinkFrameworkBinding[];
  routes: ThinkFrameworkRoute[];
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
