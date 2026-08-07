/**
 * Backend-free Computer workspace for Think agents.
 *
 * This provider stores durable files without adding a Bash tool. Think's
 * turn-level tools and codemode `state.*` adapter consume its `fs` surface.
 */
export { Workspace } from "@cloudflare/computer";
export type {
  DurableObjectStorageLike,
  WorkspaceOptions
} from "@cloudflare/computer";
