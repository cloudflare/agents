import type { StudioConfig } from "../../../src/cli/studio-config";

export type {
  StudioConfig,
  StudioAgentOption,
  StudioTarget
} from "../../../src/cli/studio-config";

const EMPTY_CONFIG: StudioConfig = { target: {}, agents: [] };

/**
 * Load the launcher-provided config. When the app is opened standalone (no
 * `think studio` server) the fetch fails and we fall back to an empty config so
 * the connect view still renders with manual inputs.
 */
export async function loadStudioConfig(): Promise<StudioConfig> {
  try {
    const response = await fetch("/__studio/config.json");
    if (!response.ok) return EMPTY_CONFIG;
    const data = (await response.json()) as Partial<StudioConfig>;
    return {
      target: data.target ?? {},
      agents: Array.isArray(data.agents) ? data.agents : []
    };
  } catch {
    return EMPTY_CONFIG;
  }
}
