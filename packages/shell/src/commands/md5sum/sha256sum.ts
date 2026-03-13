import type { Command } from "../../types";
import { createChecksumCommand } from "./checksum";

export const sha256sumCommand: Command = createChecksumCommand(
  "sha256sum",
  "sha256",
  "compute SHA256 message digest"
);

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "sha256sum",
  flags: [{ flag: "-c", type: "boolean" }],
  needsFiles: true
};
