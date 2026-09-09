// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/** Only the Skill shape is kept; upstream loads skills from the filesystem. */

import type { SourceInfo } from "./source-info.ts";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}
