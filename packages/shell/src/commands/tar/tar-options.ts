/**
 * Option parsing for tar command
 */

import type { ExecResult } from "../../types";
import { unknownOption } from "../help";

export interface TarOptions {
  create: boolean;
  append: boolean;
  update: boolean;
  extract: boolean;
  list: boolean;
  file: string;
  autoCompress: boolean;
  gzip: boolean;
  bzip2: boolean;
  xz: boolean;
  zstd: boolean;
  verbose: boolean;
  toStdout: boolean;
  keepOldFiles: boolean;
  touch: boolean;
  directory: string;
  preserve: boolean;
  absoluteNames: boolean;
  strip: number;
  exclude: string[];
  filesFrom: string;
  excludeFrom: string;
  wildcards: boolean;
}

export function parseOptions(
  args: string[]
):
  | { ok: true; options: TarOptions; files: string[] }
  | { ok: false; error: ExecResult } {
  const options: TarOptions = {
    create: false,
    append: false,
    update: false,
    extract: false,
    list: false,
    file: "",
    autoCompress: false,
    gzip: false,
    bzip2: false,
    xz: false,
    zstd: false,
    verbose: false,
    toStdout: false,
    keepOldFiles: false,
    touch: false,
    directory: "",
    preserve: false,
    absoluteNames: false,
    strip: 0,
    exclude: [],
    filesFrom: "",
    excludeFrom: "",
    wildcards: false
  };
  const files: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Handle combined short options (e.g., -cvzf)
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
      // Check if it's a negative number (shouldn't be for tar, but be safe)
      if (/^-\d+$/.test(arg)) {
        files.push(arg);
        i++;
        continue;
      }

      // Process combined short options
      for (let j = 1; j < arg.length; j++) {
        const char = arg[j];
        switch (char) {
          case "c":
            options.create = true;
            break;
          case "r":
            options.append = true;
            break;
          case "u":
            options.update = true;
            break;
          case "x":
            options.extract = true;
            break;
          case "t":
            options.list = true;
            break;
          case "a":
            options.autoCompress = true;
            break;
          case "z":
            options.gzip = true;
            break;
          case "j":
            options.bzip2 = true;
            break;
          case "J":
            options.xz = true;
            break;
          case "v":
            options.verbose = true;
            break;
          case "O":
            options.toStdout = true;
            break;
          case "k":
            options.keepOldFiles = true;
            break;
          case "m":
            options.touch = true;
            break;
          case "p":
            options.preserve = true;
            break;
          case "P":
            options.absoluteNames = true;
            break;
          case "f":
            // -f requires a value - either rest of this arg or next arg
            if (j < arg.length - 1) {
              options.file = arg.substring(j + 1);
              j = arg.length; // Stop processing this arg
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'f'\n",
                    exitCode: 2
                  }
                };
              }
              options.file = args[i];
            }
            break;
          case "C":
            // -C requires a value
            if (j < arg.length - 1) {
              options.directory = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'C'\n",
                    exitCode: 2
                  }
                };
              }
              options.directory = args[i];
            }
            break;
          case "T":
            // -T requires a value (files-from)
            if (j < arg.length - 1) {
              options.filesFrom = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'T'\n",
                    exitCode: 2
                  }
                };
              }
              options.filesFrom = args[i];
            }
            break;
          case "X":
            // -X requires a value (exclude-from)
            if (j < arg.length - 1) {
              options.excludeFrom = arg.substring(j + 1);
              j = arg.length;
            } else {
              i++;
              if (i >= args.length) {
                return {
                  ok: false,
                  error: {
                    stdout: "",
                    stderr: "tar: option requires an argument -- 'X'\n",
                    exitCode: 2
                  }
                };
              }
              options.excludeFrom = args[i];
            }
            break;
          default:
            return { ok: false, error: unknownOption("tar", `-${char}`) };
        }
      }
      i++;
      continue;
    }

    // Handle long options and single short options
    if (arg === "-c" || arg === "--create") {
      options.create = true;
    } else if (arg === "-r" || arg === "--append") {
      options.append = true;
    } else if (arg === "-u" || arg === "--update") {
      options.update = true;
    } else if (arg === "-x" || arg === "--extract" || arg === "--get") {
      options.extract = true;
    } else if (arg === "-t" || arg === "--list") {
      options.list = true;
    } else if (arg === "-a" || arg === "--auto-compress") {
      options.autoCompress = true;
    } else if (arg === "-z" || arg === "--gzip" || arg === "--gunzip") {
      options.gzip = true;
    } else if (arg === "-j" || arg === "--bzip2") {
      options.bzip2 = true;
    } else if (arg === "-J" || arg === "--xz") {
      options.xz = true;
    } else if (arg === "--zstd") {
      options.zstd = true;
    } else if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-O" || arg === "--to-stdout") {
      options.toStdout = true;
    } else if (arg === "-k" || arg === "--keep-old-files") {
      options.keepOldFiles = true;
    } else if (arg === "-m" || arg === "--touch") {
      options.touch = true;
    } else if (arg === "--wildcards") {
      options.wildcards = true;
    } else if (
      arg === "-p" ||
      arg === "--preserve" ||
      arg === "--preserve-permissions"
    ) {
      options.preserve = true;
    } else if (arg === "-P" || arg === "--absolute-names") {
      options.absoluteNames = true;
    } else if (arg === "-f" || arg === "--file") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'f'\n",
            exitCode: 2
          }
        };
      }
      options.file = args[i];
    } else if (arg.startsWith("--file=")) {
      options.file = arg.substring(7);
    } else if (arg === "-C" || arg === "--directory") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'C'\n",
            exitCode: 2
          }
        };
      }
      options.directory = args[i];
    } else if (arg.startsWith("--directory=")) {
      options.directory = arg.substring(12);
    } else if (
      arg.startsWith("--strip-components=") ||
      arg.startsWith("--strip=")
    ) {
      const val = arg.includes("--strip-components=")
        ? arg.substring(19)
        : arg.substring(8);
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 0) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: `tar: invalid number for --strip: '${val}'\n`,
            exitCode: 2
          }
        };
      }
      options.strip = num;
    } else if (arg.startsWith("--exclude=")) {
      options.exclude.push(arg.substring(10));
    } else if (arg === "--exclude") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option '--exclude' requires an argument\n",
            exitCode: 2
          }
        };
      }
      options.exclude.push(args[i]);
    } else if (arg === "-T" || arg === "--files-from") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'T'\n",
            exitCode: 2
          }
        };
      }
      options.filesFrom = args[i];
    } else if (arg.startsWith("--files-from=")) {
      options.filesFrom = arg.substring(13);
    } else if (arg === "-X" || arg === "--exclude-from") {
      i++;
      if (i >= args.length) {
        return {
          ok: false,
          error: {
            stdout: "",
            stderr: "tar: option requires an argument -- 'X'\n",
            exitCode: 2
          }
        };
      }
      options.excludeFrom = args[i];
    } else if (arg.startsWith("--exclude-from=")) {
      options.excludeFrom = arg.substring(15);
    } else if (arg === "--") {
      // End of options
      files.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      return { ok: false, error: unknownOption("tar", arg) };
    } else {
      files.push(arg);
    }
    i++;
  }

  return { ok: true, options, files };
}
