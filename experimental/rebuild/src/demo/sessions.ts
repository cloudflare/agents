/** Where the interactive demo keeps session logs, and how to find them. */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const SESSIONS_DIR = ".sessions";

/** Newest session log, or null if none. Names sort chronologically. */
export function newestSession(): string | null {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".db"));
  } catch {
    return null; // no directory yet
  }
  if (names.length === 0) return null;
  return join(SESSIONS_DIR, names.sort().at(-1) as string);
}
