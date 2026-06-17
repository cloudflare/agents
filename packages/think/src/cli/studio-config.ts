/**
 * Shared, dependency-free types and helpers for the `/__studio/config.json`
 * document the `think studio` launcher serves to the Studio SPA. Kept pure so
 * it is importable from both the Node launcher (`studio.ts`) and the browser
 * app (type-only) without dragging in any runtime dependency.
 */

/** An agent the Studio connect view can offer as a picker option. */
export interface StudioAgentOption {
  /** Canonical route id (what the server resolves). */
  id: string;
  /** Human label for the picker (defaults to the id). */
  label: string;
}

/** The initial connection the launcher was pointed at. */
export interface StudioTarget {
  /** Remote origin, e.g. `https://app.example.com`. */
  url?: string;
  /** Local host[:port]. */
  host?: string;
  /** Override the derived protocol. */
  protocol?: "ws" | "wss";
  /** Auth token, sent as the `token` query param. */
  token?: string;
  /** Initial agent id/segment. */
  agent?: string;
  /** Initial instance name. */
  instance?: string;
  /** Route prefix (default `agents`). */
  routePrefix?: string;
}

export interface StudioConfig {
  target: StudioTarget;
  /** Top-level agents discovered from the local manifest (empty for remote). */
  agents: StudioAgentOption[];
}

/** Minimal manifest shape needed to build the agent picker options. */
interface ManifestLike {
  agents: Array<{
    id: string;
    kind: string;
    bindingName?: string;
  }>;
}

/**
 * Build the `/__studio/config.json` payload from the resolved target and the
 * (optional) local manifest. Pure so it can be unit-tested directly.
 */
export function buildStudioConfig(input: {
  target: StudioTarget;
  manifest?: ManifestLike | null;
}): StudioConfig {
  const agents: StudioAgentOption[] = (input.manifest?.agents ?? [])
    .filter((entry) => entry.kind === "top-level")
    .map((entry) => ({ id: entry.id, label: entry.bindingName || entry.id }));
  return { target: input.target, agents };
}
