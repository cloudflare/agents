/**
 * shopt builtin - Shell options
 * Implements bash's shopt builtin for managing shell-specific options
 */

import type { ExecResult } from "../../types";
import { updateBashopts, updateShellopts } from "../helpers/shellopts";
import type { InterpreterContext } from "../types";

// All supported shopt options
const SHOPT_OPTIONS = [
  "extglob",
  "dotglob",
  "nullglob",
  "failglob",
  "globstar",
  "globskipdots",
  "nocaseglob",
  "nocasematch",
  "expand_aliases",
  "lastpipe",
  "xpg_echo"
] as const;

// Options that are recognized but not implemented (stubs that return current state)
const STUB_OPTIONS = [
  "autocd",
  "cdable_vars",
  "cdspell",
  "checkhash",
  "checkjobs",
  "checkwinsize",
  "cmdhist",
  "compat31",
  "compat32",
  "compat40",
  "compat41",
  "compat42",
  "compat43",
  "compat44",
  "complete_fullquote",
  "direxpand",
  "dirspell",
  "execfail",
  "extdebug",
  "extquote",
  "force_fignore",
  "globasciiranges",
  "gnu_errfmt",
  "histappend",
  "histreedit",
  "histverify",
  "hostcomplete",
  "huponexit",
  "inherit_errexit",
  "interactive_comments",
  "lithist",
  "localvar_inherit",
  "localvar_unset",
  "login_shell",
  "mailwarn",
  "no_empty_cmd_completion",
  "progcomp",
  "progcomp_alias",
  "promptvars",
  "restricted_shell",
  "shift_verbose",
  "sourcepath"
] as const;

type ShoptOption = (typeof SHOPT_OPTIONS)[number];

function isShoptOption(opt: string): opt is ShoptOption {
  return SHOPT_OPTIONS.includes(opt as ShoptOption);
}

function isStubOption(opt: string): boolean {
  return STUB_OPTIONS.includes(opt as (typeof STUB_OPTIONS)[number]);
}

export function handleShopt(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  // Parse arguments
  let setFlag = false; // -s: set option
  let unsetFlag = false; // -u: unset option
  let printFlag = false; // -p: print in reusable form
  let quietFlag = false; // -q: suppress output, only set exit code
  let oFlag = false; // -o: use set -o option names
  const optionNames: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        switch (flag) {
          case "s":
            setFlag = true;
            break;
          case "u":
            unsetFlag = true;
            break;
          case "p":
            printFlag = true;
            break;
          case "q":
            quietFlag = true;
            break;
          case "o":
            oFlag = true;
            break;
          default:
            return {
              exitCode: 2,
              stdout: "",
              stderr: `shopt: -${flag}: invalid option\n`
            };
        }
      }
      i++;
    } else {
      break;
    }
  }

  // Remaining args are option names
  while (i < args.length) {
    optionNames.push(args[i]);
    i++;
  }

  // -o flag: use set -o option names instead of shopt options
  if (oFlag) {
    return handleSetOptions(
      ctx,
      optionNames,
      setFlag,
      unsetFlag,
      printFlag,
      quietFlag
    );
  }

  // If -s and -u are both set, that's an error
  if (setFlag && unsetFlag) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "shopt: cannot set and unset shell options simultaneously\n"
    };
  }

  // No option names: print all options
  if (optionNames.length === 0) {
    if (setFlag || unsetFlag) {
      // -s or -u without option names: print options with that state
      const output: string[] = [];
      for (const opt of SHOPT_OPTIONS) {
        const value = ctx.state.shoptOptions[opt];
        if (setFlag && value) {
          output.push(printFlag ? `shopt -s ${opt}` : `${opt}\t\ton`);
        } else if (unsetFlag && !value) {
          output.push(printFlag ? `shopt -u ${opt}` : `${opt}\t\toff`);
        }
      }
      return {
        exitCode: 0,
        stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
        stderr: ""
      };
    }
    // No flags: print all options
    const output: string[] = [];
    for (const opt of SHOPT_OPTIONS) {
      const value = ctx.state.shoptOptions[opt];
      output.push(
        printFlag
          ? `shopt ${value ? "-s" : "-u"} ${opt}`
          : `${opt}\t\t${value ? "on" : "off"}`
      );
    }
    return {
      exitCode: 0,
      stdout: `${output.join("\n")}\n`,
      stderr: ""
    };
  }

  // Option names provided
  let hasError = false;
  let stderr = "";
  const output: string[] = [];

  for (const name of optionNames) {
    if (!isShoptOption(name) && !isStubOption(name)) {
      stderr += `shopt: ${name}: invalid shell option name\n`;
      hasError = true;
      continue;
    }

    if (setFlag) {
      // Set the option
      if (isShoptOption(name)) {
        ctx.state.shoptOptions[name] = true;
        updateBashopts(ctx);
      }
      // Stub options are silently accepted
    } else if (unsetFlag) {
      // Unset the option
      if (isShoptOption(name)) {
        ctx.state.shoptOptions[name] = false;
        updateBashopts(ctx);
      }
      // Stub options are silently accepted
    } else {
      // Query the option
      if (isShoptOption(name)) {
        const value = ctx.state.shoptOptions[name];
        if (quietFlag) {
          if (!value) {
            hasError = true;
          }
        } else if (printFlag) {
          output.push(`shopt ${value ? "-s" : "-u"} ${name}`);
          // In bash, shopt -p returns exit code 1 if the option is unset
          if (!value) {
            hasError = true;
          }
        } else {
          output.push(`${name}\t\t${value ? "on" : "off"}`);
          // In bash, shopt without flags returns exit code 1 if the option is unset
          if (!value) {
            hasError = true;
          }
        }
      } else {
        // Stub options report as off
        if (quietFlag) {
          hasError = true;
        } else if (printFlag) {
          output.push(`shopt -u ${name}`);
          hasError = true; // Stub options are always off
        } else {
          output.push(`${name}\t\toff`);
          hasError = true; // Stub options are always off
        }
      }
    }
  }

  return {
    exitCode: hasError ? 1 : 0,
    stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
    stderr
  };
}

/**
 * Handle -o flag: use set -o option names
 */
function handleSetOptions(
  ctx: InterpreterContext,
  optionNames: string[],
  setFlag: boolean,
  unsetFlag: boolean,
  printFlag: boolean,
  quietFlag: boolean
): ExecResult {
  // Map set -o option names to ShellOptions (implemented options)
  const SET_OPTIONS = new Map<string, keyof typeof ctx.state.options>([
    ["errexit", "errexit"],
    ["pipefail", "pipefail"],
    ["nounset", "nounset"],
    ["xtrace", "xtrace"],
    ["verbose", "verbose"],
    ["posix", "posix"],
    ["allexport", "allexport"],
    ["noclobber", "noclobber"],
    ["noglob", "noglob"],
    ["noexec", "noexec"],
    ["vi", "vi"],
    ["emacs", "emacs"]
  ]);

  // No-op options (recognized but always off, for compatibility with set -o)
  const NOOP_OPTIONS = [
    "braceexpand",
    "errtrace",
    "functrace",
    "hashall",
    "histexpand",
    "history",
    "ignoreeof",
    "interactive-comments",
    "keyword",
    "monitor",
    "nolog",
    "notify",
    "onecmd",
    "physical",
    "privileged"
  ];

  const ALL_SET_OPTIONS = [...SET_OPTIONS.keys(), ...NOOP_OPTIONS].sort();

  if (optionNames.length === 0) {
    // Print all set -o options
    const output: string[] = [];
    for (const opt of ALL_SET_OPTIONS) {
      const isNoOp = NOOP_OPTIONS.includes(opt);
      const optKey = SET_OPTIONS.get(opt);
      const value = isNoOp || !optKey ? false : ctx.state.options[optKey];
      if (setFlag && !value) continue;
      if (unsetFlag && value) continue;
      output.push(
        printFlag
          ? `set ${value ? "-o" : "+o"} ${opt}`
          : `${opt}\t\t${value ? "on" : "off"}`
      );
    }
    return {
      exitCode: 0,
      stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
      stderr: ""
    };
  }

  let hasError = false;
  let stderr = "";
  const output: string[] = [];

  for (const name of optionNames) {
    const isImplemented = SET_OPTIONS.has(name);
    const isNoOp = NOOP_OPTIONS.includes(name);

    if (!isImplemented && !isNoOp) {
      stderr += `shopt: ${name}: invalid option name\n`;
      hasError = true;
      continue;
    }

    if (isNoOp) {
      // No-op options are always off and can't be changed
      if (setFlag || unsetFlag) {
        // Silently accept setting/unsetting no-op options (like bash)
      } else {
        // Query the option
        if (quietFlag) {
          hasError = true; // No-op options are always off
        } else if (printFlag) {
          output.push(`set +o ${name}`);
          hasError = true; // Always off
        } else {
          output.push(`${name}\t\toff`);
          hasError = true; // Always off
        }
      }
      continue;
    }

    const key = SET_OPTIONS.get(name);
    if (!key) continue; // Should not happen since we validated above

    if (setFlag) {
      // Handle mutual exclusivity of vi and emacs
      if (key === "vi") {
        ctx.state.options.emacs = false;
      } else if (key === "emacs") {
        ctx.state.options.vi = false;
      }
      ctx.state.options[key] = true;
      updateShellopts(ctx);
    } else if (unsetFlag) {
      ctx.state.options[key] = false;
      updateShellopts(ctx);
    } else {
      const value = ctx.state.options[key];
      if (quietFlag) {
        if (!value) {
          hasError = true;
        }
      } else if (printFlag) {
        output.push(`set ${value ? "-o" : "+o"} ${name}`);
        // In bash, shopt -o -p returns exit code 1 if the option is unset
        if (!value) {
          hasError = true;
        }
      } else {
        output.push(`${name}\t\t${value ? "on" : "off"}`);
        // In bash, shopt -o without flags returns exit code 1 if the option is unset
        if (!value) {
          hasError = true;
        }
      }
    }
  }

  return {
    exitCode: hasError ? 1 : 0,
    stdout: output.length > 0 ? `${output.join("\n")}\n` : "",
    stderr
  };
}
