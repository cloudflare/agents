// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream installs npm/git resource packages. core/source-info.ts only needs
 * the metadata shape.
 */

import type { SourceScope } from "./source-info.ts";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
}
