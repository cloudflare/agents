import type {
  WorkspaceClient,
  WorkspaceRuntimeValue,
  WorkspaceStub
} from "@cloudflare/computer";
import type { CodemodeConnector } from "@cloudflare/codemode";
import type { ToolSet } from "ai";

export type ThinkWorkspaceFilesystem = Pick<
  WorkspaceClient["fs"],
  "readFile" | "stat" | "readdir" | "find" | "writeFile" | "mkdir" | "rm"
>;

export interface ThinkWorkspaceRuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  value?: unknown;
}

export interface ThinkWorkspaceRuntimeHandle {
  result(): Promise<ThinkWorkspaceRuntimeResult>;
  [Symbol.dispose]?(): void;
}

export interface ThinkWorkspaceRuntime {
  exec(
    source: string,
    options?: {
      cwd?: string;
      encoding?: "utf8";
      backend?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      input?: WorkspaceRuntimeValue;
      stdin?: Uint8Array | string;
    }
  ): Promise<ThinkWorkspaceRuntimeHandle>;
}

/** The native Computer-shaped workspace surface used by Think. */
export interface ThinkWorkspace {
  readonly fs: ThinkWorkspaceFilesystem;
  readonly runtime: ThinkWorkspaceRuntime;
}

export const workspaceToolProvider: unique symbol = Symbol.for(
  "@cloudflare/think/workspace-tool-provider"
) as unknown as typeof workspaceToolProvider;

export const workspaceStubProvider: unique symbol = Symbol.for(
  "@cloudflare/think/workspace-stub-provider"
) as unknown as typeof workspaceStubProvider;

export const workspaceStateProvider: unique symbol = Symbol.for(
  "@cloudflare/think/workspace-state-provider"
) as unknown as typeof workspaceStateProvider;

export const workspaceLegacyBashProvider: unique symbol = Symbol.for(
  "@cloudflare/think/workspace-legacy-bash-provider"
) as unknown as typeof workspaceLegacyBashProvider;

export interface LegacyWorkspaceBashOptions {
  timeout?: number;
  network?: boolean;
  maxWorkspaceFiles?: number;
  maxWorkspaceFileBytes?: number;
  maxOutputBytes?: number;
}

export interface WorkspaceToolProviderOptions {
  /** @deprecated Passed only to the legacy shell workspace. */
  legacyBash?: boolean | LegacyWorkspaceBashOptions;
}

/** Opt-in tools supplied by a configured workspace implementation. */
export interface WorkspaceToolProvider {
  [workspaceToolProvider](options?: WorkspaceToolProviderOptions): ToolSet;
}

export interface WorkspaceStubProvider {
  [workspaceStubProvider](): Promise<WorkspaceStub>;
}

export interface WorkspaceStateProvider {
  [workspaceStateProvider](
    ctx: DurableObjectState | ExecutionContext
  ): CodemodeConnector[];
}

export interface WorkspaceLegacyBashProvider {
  readonly [workspaceLegacyBashProvider]: true;
}

export function hasWorkspaceToolProvider(
  workspace: ThinkWorkspace
): workspace is ThinkWorkspace & WorkspaceToolProvider {
  const candidate = workspace as ThinkWorkspace &
    Partial<WorkspaceToolProvider>;
  return typeof candidate[workspaceToolProvider] === "function";
}

export function hasWorkspaceLegacyBashProvider(
  workspace: ThinkWorkspace
): workspace is ThinkWorkspace & WorkspaceLegacyBashProvider {
  return (
    workspaceLegacyBashProvider in workspace &&
    workspace[workspaceLegacyBashProvider] === true
  );
}

export function hasWorkspaceStateProvider(
  workspace: ThinkWorkspace
): workspace is ThinkWorkspace & WorkspaceStateProvider {
  const candidate = workspace as ThinkWorkspace &
    Partial<WorkspaceStateProvider>;
  return typeof candidate[workspaceStateProvider] === "function";
}

export function hasWorkspaceStubProvider(
  workspace: ThinkWorkspace
): workspace is ThinkWorkspace & WorkspaceStubProvider {
  const candidate = workspace as ThinkWorkspace &
    Partial<WorkspaceStubProvider>;
  return typeof candidate[workspaceStubProvider] === "function";
}

export function normalizeWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export async function writeWorkspaceFile(
  workspace: ThinkWorkspace,
  path: string,
  data: string | Uint8Array
): Promise<void> {
  const normalizedPath = normalizeWorkspacePath(path);
  const lastSlash = normalizedPath.lastIndexOf("/");
  const parent = normalizedPath.slice(0, lastSlash) || "/";
  if (parent !== "/") {
    await workspace.fs.mkdir(parent, { recursive: true });
  }
  await workspace.fs.writeFile(normalizedPath, data);
}

export async function readWorkspaceText(
  workspace: ThinkWorkspace,
  path: string
): Promise<string | null> {
  try {
    return await workspace.fs.readFile(normalizeWorkspacePath(path), "utf8");
  } catch (error) {
    if (isWorkspaceNotFoundError(error)) return null;
    throw error;
  }
}

export function isWorkspaceNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "ENOENT" ||
    (typeof candidate.message === "string" &&
      /ENOENT|no such/i.test(candidate.message))
  );
}
