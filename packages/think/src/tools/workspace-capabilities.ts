export const workspaceShellCapability = Symbol.for(
  "@cloudflare/think/workspace-shell"
);

export interface WorkspaceShellExecutor {
  exec(
    command: string,
    options: {
      cwd?: string;
      encoding: "utf8";
      timeoutMs?: number;
    }
  ): Promise<{
    result(): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }>;
}

export interface WorkspaceWithShellCapability {
  [workspaceShellCapability]?: WorkspaceShellExecutor;
}
