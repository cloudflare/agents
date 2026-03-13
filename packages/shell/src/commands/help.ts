import type { ExecResult } from "../types";

export interface HelpInfo {
  name: string;
  summary: string;
  usage: string;
  description?: string | string[];
  options?: string[];
  examples?: string[];
  notes?: string[];
}

export function showHelp(info: HelpInfo): ExecResult {
  let output = `${info.name} - ${info.summary}\n\n`;
  output += `Usage: ${info.usage}\n`;
  if (info.description) {
    output += "\nDescription:\n";
    if (typeof info.description === "string") {
      // Handle multi-line string description (legacy format)
      for (const line of info.description.split("\n")) {
        output += line ? `  ${line}\n` : "\n";
      }
    } else if (info.description.length > 0) {
      // Handle array description (new format)
      for (const line of info.description) {
        output += line ? `  ${line}\n` : "\n";
      }
    }
  }
  if (info.options && info.options.length > 0) {
    output += "\nOptions:\n";
    for (const opt of info.options) {
      output += `  ${opt}\n`;
    }
  }
  if (info.examples && info.examples.length > 0) {
    output += "\nExamples:\n";
    for (const example of info.examples) {
      output += `  ${example}\n`;
    }
  }
  if (info.notes && info.notes.length > 0) {
    output += "\nNotes:\n";
    for (const note of info.notes) {
      output += `  ${note}\n`;
    }
  }
  return { stdout: output, stderr: "", exitCode: 0 };
}

export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help");
}

/**
 * Returns an error result for an unknown option
 */
export function unknownOption(cmdName: string, option: string): ExecResult {
  // For single-char options, use "invalid option -- 'x'" format
  // For long options, use "unrecognized option '--xxx'" format
  const msg = option.startsWith("--")
    ? `${cmdName}: unrecognized option '${option}'\n`
    : `${cmdName}: invalid option -- '${option.replace(/^-/, "")}'\n`;
  return { stdout: "", stderr: msg, exitCode: 1 };
}
