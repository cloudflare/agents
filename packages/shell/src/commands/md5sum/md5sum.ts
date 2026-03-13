import type { Command } from "../../types";
import { createChecksumCommand } from "./checksum";

export const md5sumCommand: Command = createChecksumCommand(
  "md5sum",
  "md5",
  "compute MD5 message digest"
);

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "md5sum",
  flags: [{ flag: "-c", type: "boolean" }],
  needsFiles: true
};
