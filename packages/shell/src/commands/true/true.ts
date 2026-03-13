import type { Command, ExecResult } from "../../types";

export const trueCommand: Command = {
  name: "true",

  async execute(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
};

export const falseCommand: Command = {
  name: "false",

  async execute(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "true",
  flags: []
};

export const falseFlagsForFuzzing: CommandFuzzInfo = {
  name: "false",
  flags: []
};
