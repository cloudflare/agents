import type {
  ThinkWorkspace,
  ThinkWorkspaceFilesystem
} from "@cloudflare/think";

/**
 * A Think workspace that resolves the real one on first use, so the agent
 * does not reach the Workspace's owner until a turn touches a file.
 *
 * The resolved Workspace is reused. A failed resolution is dropped, so the
 * next operation tries again. Only `fs` is forwarded: the agent gets the file
 * tools but no `exec`.
 */
export function lazyWorkspace(
  resolve: () => Promise<ThinkWorkspace>
): ThinkWorkspace {
  let resolved: Promise<ThinkWorkspace> | undefined;
  const fs = async (): Promise<ThinkWorkspaceFilesystem> => {
    resolved ??= resolve().catch((error: unknown) => {
      resolved = undefined;
      throw error;
    });
    return (await resolved).fs;
  };
  type Fs = ThinkWorkspaceFilesystem;
  const forwarding = {
    readFile: async (...args: Parameters<Fs["readFile"]>) =>
      (await fs()).readFile(...args),
    writeFile: async (...args: Parameters<Fs["writeFile"]>) =>
      (await fs()).writeFile(...args),
    mkdir: async (...args: Parameters<Fs["mkdir"]>) =>
      (await fs()).mkdir(...args),
    rm: async (...args: Parameters<Fs["rm"]>) => (await fs()).rm(...args),
    stat: async (...args: Parameters<Fs["stat"]>) => (await fs()).stat(...args),
    readdir: async (...args: Parameters<Fs["readdir"]>) =>
      (await fs()).readdir(...args),
    find: async (...args: Parameters<Fs["find"]>) => (await fs()).find(...args),
    grep: async (...args: Parameters<Fs["grep"]>) => (await fs()).grep(...args)
  };
  // SAFETY: Every method forwards its arguments unchanged to the same method
  // on the resolved filesystem, so each `readFile` overload returns what the
  // resolved overload returns. TypeScript cannot carry overloads through a
  // forwarding wrapper.
  return { fs: forwarding as unknown as Fs };
}
