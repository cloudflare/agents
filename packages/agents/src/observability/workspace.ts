import type { BaseEvent } from "./base";

/**
 * Workspace-specific observability events.
 * These track file operations and directory changes within a Workspace instance.
 */
export type WorkspaceObservabilityEvent =
  | BaseEvent<
      "workspace:read",
      { namespace: string; path: string; storage: "inline" | "r2" }
    >
  | BaseEvent<
      "workspace:write",
      {
        namespace: string;
        path: string;
        size: number;
        storage: "inline" | "r2";
        update: boolean;
      }
    >
  | BaseEvent<"workspace:delete", { namespace: string; path: string }>
  | BaseEvent<
      "workspace:mkdir",
      { namespace: string; path: string; recursive: boolean }
    >
  | BaseEvent<
      "workspace:rm",
      { namespace: string; path: string; recursive: boolean }
    >
  | BaseEvent<
      "workspace:cp",
      { namespace: string; src: string; dest: string; recursive: boolean }
    >
  | BaseEvent<"workspace:mv", { namespace: string; src: string; dest: string }>
  | BaseEvent<
      "workspace:error",
      { namespace: string; operation: string; path: string; error: string }
    >;
