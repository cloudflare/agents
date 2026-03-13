/**
 * help - Display helpful information about builtin commands
 *
 * Usage: help [-s] [pattern ...]
 *
 * If PATTERN is specified, gives detailed help on all commands matching PATTERN,
 * otherwise a list of the builtins is printed. The -s option restricts the output
 * for each builtin command matching PATTERN to a short usage synopsis.
 */

import { createUserRegex } from "../../regex/index";
import type { ExecResult } from "../../types";
import { failure, success } from "../helpers/result";
import type { InterpreterContext } from "../types";

/**
 * Builtin help information: [synopsis, description]
 * The synopsis is the short form shown with -s and in the list.
 * The description is the detailed help text.
 */
const BUILTIN_HELP = new Map<string, [string, string]>([
  [
    ":",
    [
      ": [arguments]",
      `Null command.
    No effect; the command does nothing.
    Exit Status:
    Always succeeds.`
    ]
  ],
  [
    ".",
    [
      ". filename [arguments]",
      `Execute commands from a file in the current shell.
    Read and execute commands from FILENAME in the current shell.
    The entries in $PATH are used to find the directory containing FILENAME.
    Exit Status:
    Returns the status of the last command executed in FILENAME.`
    ]
  ],
  [
    "[",
    [
      "[ arg... ]",
      `Evaluate conditional expression.
    This is a synonym for the "test" builtin, but the last argument must
    be a literal \`]', to match the opening \`['.`
    ]
  ],
  [
    "alias",
    [
      "alias [-p] [name[=value] ... ]",
      `Define or display aliases.
    Without arguments, \`alias' prints the list of aliases in the reusable
    form \`alias NAME=VALUE' on standard output.
    Exit Status:
    alias returns true unless a NAME is supplied for which no alias has been
    defined.`
    ]
  ],
  [
    "bg",
    [
      "bg [job_spec ...]",
      `Move jobs to the background.
    Place the jobs identified by each JOB_SPEC in the background, as if they
    had been started with \`&'.`
    ]
  ],
  [
    "break",
    [
      "break [n]",
      `Exit for, while, or until loops.
    Exit a FOR, WHILE or UNTIL loop.  If N is specified, break N enclosing
    loops.
    Exit Status:
    The exit status is 0 unless N is not greater than or equal to 1.`
    ]
  ],
  [
    "builtin",
    [
      "builtin [shell-builtin [arg ...]]",
      `Execute shell builtins.
    Execute SHELL-BUILTIN with arguments ARGs without performing command
    lookup.  This is useful when you wish to reimplement a shell builtin
    as a shell function, but need to execute the builtin within the function.
    Exit Status:
    Returns the exit status of SHELL-BUILTIN, or false if SHELL-BUILTIN is
    not a shell builtin.`
    ]
  ],
  [
    "caller",
    [
      "caller [expr]",
      `Return the context of the current subroutine call.
    Without EXPR, returns "$line $filename".  With EXPR, returns
    "$line $subroutine $filename"; this extra information can be used to
    provide a stack trace.
    Exit Status:
    Returns 0 unless the shell is not executing a subroutine call or
    EXPR is invalid.`
    ]
  ],
  [
    "cd",
    [
      "cd [-L|-P] [dir]",
      `Change the shell working directory.
    Change the current directory to DIR.  The default DIR is the value of the
    HOME shell variable.

    The variable CDPATH defines the search path for the directory containing
    DIR.  Alternative directory names in CDPATH are separated by a colon (:).
    A null directory name is the same as the current directory.  If DIR begins
    with a slash (/), then CDPATH is not used.

    If the directory is not found, and the shell option \`cdable_vars' is set,
    the word is assumed to be a variable name.  If that variable has a value,
    its value is used for DIR.

    Options:
      -L	force symbolic links to be followed
      -P	use the physical directory structure without following symbolic
    	links

    The default is to follow symbolic links, as if \`-L' were specified.

    Exit Status:
    Returns 0 if the directory is changed; non-zero otherwise.`
    ]
  ],
  [
    "command",
    [
      "command [-pVv] command [arg ...]",
      `Execute a simple command or display information about commands.
    Runs COMMAND with ARGS suppressing shell function lookup, or display
    information about the specified COMMANDs.

    Options:
      -p	use a default value for PATH that is guaranteed to find all of
    	the standard utilities
      -v	print a description of COMMAND similar to the \`type' builtin
      -V	print a more verbose description of each COMMAND

    Exit Status:
    Returns exit status of COMMAND, or failure if COMMAND is not found.`
    ]
  ],
  [
    "compgen",
    [
      "compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist]  [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]",
      `Display possible completions depending on the options.
    Intended to be used from within a shell function generating possible
    completions.  If the optional WORD argument is supplied, matches against
    WORD are generated.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
    ]
  ],
  [
    "complete",
    [
      "complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist]  [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]",
      `Specify how arguments are to be completed.
    For each NAME, specify how arguments are to be completed.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
    ]
  ],
  [
    "continue",
    [
      "continue [n]",
      `Resume for, while, or until loops.
    Resumes the next iteration of the enclosing FOR, WHILE or UNTIL loop.
    If N is specified, resumes the Nth enclosing loop.
    Exit Status:
    The exit status is 0 unless N is not greater than or equal to 1.`
    ]
  ],
  [
    "declare",
    [
      "declare [-aAfFgilnrtux] [-p] [name[=value] ...]",
      `Set variable values and attributes.
    Declare variables and give them attributes.  If no NAMEs are given,
    display the attributes and values of all variables.

    Options:
      -a	to make NAMEs indexed arrays (if supported)
      -A	to make NAMEs associative arrays (if supported)
      -i	to make NAMEs have the \`integer' attribute
      -l	to convert the value of each NAME to lower case on assignment
      -n	make NAME a reference to the variable named by its value
      -r	to make NAMEs readonly
      -t	to make NAMEs have the \`trace' attribute
      -u	to convert the value of each NAME to upper case on assignment
      -x	to make NAMEs export

    Exit Status:
    Returns success unless an invalid option is supplied or a variable
    assignment error occurs.`
    ]
  ],
  [
    "dirs",
    [
      "dirs [-clpv] [+N] [-N]",
      `Display directory stack.
    Display the list of currently remembered directories.  Directories
    find their way onto the list with the \`pushd' command; you can get
    back up through the list with the \`popd' command.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
    ]
  ],
  [
    "disown",
    [
      "disown [-h] [-ar] [jobspec ...]",
      `Remove jobs from current shell.
    Without any JOBSPECs, remove the current job.`
    ]
  ],
  [
    "echo",
    [
      "echo [-neE] [arg ...]",
      `Write arguments to the standard output.
    Display the ARGs, separated by a single space character and followed by a
    newline, on the standard output.

    Options:
      -n	do not append a newline
      -e	enable interpretation of the following backslash escapes
      -E	explicitly suppress interpretation of backslash escapes

    Exit Status:
    Returns success unless a write error occurs.`
    ]
  ],
  [
    "enable",
    [
      "enable [-a] [-dnps] [-f filename] [name ...]",
      `Enable and disable shell builtins.
    Enables and disables builtin shell commands.
    Exit Status:
    Returns success unless NAME is not a shell builtin or an error occurs.`
    ]
  ],
  [
    "eval",
    [
      "eval [arg ...]",
      `Execute arguments as a shell command.
    Combine ARGs into a single string, use the result as input to the shell,
    and execute the resulting commands.
    Exit Status:
    Returns exit status of command or success if command is null.`
    ]
  ],
  [
    "exec",
    [
      "exec [-cl] [-a name] [command [arguments ...]] [redirection ...]",
      `Replace the shell with the given command.
    Execute COMMAND, replacing this shell with the specified program.
    ARGUMENTS become the arguments to COMMAND.  If COMMAND is not specified,
    any redirections take effect in the current shell.
    Exit Status:
    Returns success unless COMMAND is not found or a redirection error occurs.`
    ]
  ],
  [
    "exit",
    [
      "exit [n]",
      `Exit the shell.
    Exits the shell with a status of N.  If N is omitted, the exit status
    is that of the last command executed.`
    ]
  ],
  [
    "export",
    [
      "export [-fn] [name[=value] ...] or export -p",
      `Set export attribute for shell variables.
    Marks each NAME for automatic export to the environment of subsequently
    executed commands.  If VALUE is supplied, assign VALUE before exporting.

    Options:
      -f	refer to shell functions
      -n	remove the export property from each NAME
      -p	display a list of all exported variables and functions

    Exit Status:
    Returns success unless an invalid option is given or NAME is invalid.`
    ]
  ],
  [
    "false",
    [
      "false",
      `Return an unsuccessful result.
    Exit Status:
    Always fails.`
    ]
  ],
  [
    "fc",
    [
      "fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]",
      `Display or execute commands from the history list.
    Exit Status:
    Returns success or status of executed command.`
    ]
  ],
  [
    "fg",
    [
      "fg [job_spec]",
      `Move job to the foreground.
    Place the job identified by JOB_SPEC in the foreground, making it the
    current job.`
    ]
  ],
  [
    "getopts",
    [
      "getopts optstring name [arg]",
      `Parse option arguments.
    Getopts is used by shell procedures to parse positional parameters
    as options.

    OPTSTRING contains the option letters to be recognized; if a letter
    is followed by a colon, the option is expected to have an argument,
    which should be separated from it by white space.
    Exit Status:
    Returns success if an option is found; fails if the end of options is
    encountered or an error occurs.`
    ]
  ],
  [
    "hash",
    [
      "hash [-lr] [-p pathname] [-dt] [name ...]",
      `Remember or display program locations.
    Determine and remember the full pathname of each command NAME.
    Exit Status:
    Returns success unless NAME is not found or an invalid option is given.`
    ]
  ],
  [
    "help",
    [
      "help [-s] [pattern ...]",
      `Display information about builtin commands.
    Displays brief summaries of builtin commands.  If PATTERN is
    specified, gives detailed help on all commands matching PATTERN,
    otherwise the list of help topics is printed.

    Options:
      -s	output only a short usage synopsis for each topic matching
    	PATTERN

    Exit Status:
    Returns success unless PATTERN is not found.`
    ]
  ],
  [
    "history",
    [
      "history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]",
      `Display or manipulate the history list.
    Display the history list with line numbers, prefixing each modified
    entry with a \`*'.
    Exit Status:
    Returns success unless an invalid option is given or an error occurs.`
    ]
  ],
  [
    "jobs",
    [
      "jobs [-lnprs] [jobspec ...] or jobs -x command [args]",
      `Display status of jobs.
    Lists the active jobs.
    Exit Status:
    Returns success unless an invalid option is given or an error occurs.`
    ]
  ],
  [
    "kill",
    [
      "kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]",
      `Send a signal to a job.
    Send the processes identified by PID or JOBSPEC the signal named by
    SIGSPEC or SIGNUM.
    Exit Status:
    Returns success unless an invalid option is given or an error occurs.`
    ]
  ],
  [
    "let",
    [
      "let arg [arg ...]",
      `Evaluate arithmetic expressions.
    Evaluate each ARG as an arithmetic expression.  Evaluation is done in
    fixed-width integers with no check for overflow, though division by 0
    is trapped and flagged as an error.
    Exit Status:
    If the last ARG evaluates to 0, let returns 1; 0 is returned otherwise.`
    ]
  ],
  [
    "local",
    [
      "local [option] name[=value] ...",
      `Define local variables.
    Create a local variable called NAME, and give it VALUE.  OPTION can
    be any option accepted by \`declare'.

    Local can only be used within a function; it makes the variable NAME
    have a visible scope restricted to that function and its children.
    Exit Status:
    Returns success unless an invalid option is supplied, a variable
    assignment error occurs, or the shell is not executing a function.`
    ]
  ],
  [
    "logout",
    [
      "logout [n]",
      `Exit a login shell.
    Exits a login shell with exit status N.  Returns an error if not executed
    in a login shell.`
    ]
  ],
  [
    "mapfile",
    [
      "mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]",
      `Read lines from the standard input into an indexed array variable.
    Read lines from the standard input into the indexed array variable ARRAY,
    or from file descriptor FD if the -u option is supplied.

    Options:
      -d delim	Use DELIM to terminate lines, instead of newline
      -n count	Copy at most COUNT lines
      -O origin	Begin assigning to ARRAY at index ORIGIN
      -s count	Discard the first COUNT lines read
      -t	Remove a trailing DELIM from each line read (default newline)
      -u fd	Read lines from file descriptor FD instead of standard input

    Exit Status:
    Returns success unless an invalid option is given or ARRAY is readonly.`
    ]
  ],
  [
    "popd",
    [
      "popd [-n] [+N | -N]",
      `Remove directories from stack.
    Removes entries from the directory stack.
    Exit Status:
    Returns success unless an invalid argument is supplied or the directory
    change fails.`
    ]
  ],
  [
    "printf",
    [
      "printf [-v var] format [arguments]",
      `Formats and prints ARGUMENTS under control of the FORMAT.

    Options:
      -v var	assign the output to shell variable VAR rather than
    		display it on the standard output

    FORMAT is a character string which contains three types of objects: plain
    characters, which are simply copied to standard output; character escape
    sequences, which are converted and copied to the standard output; and
    format specifications, each of which causes printing of the next successive
    argument.
    Exit Status:
    Returns success unless an invalid option is given or a write or assignment
    error occurs.`
    ]
  ],
  [
    "pushd",
    [
      "pushd [-n] [+N | -N | dir]",
      `Add directories to stack.
    Adds a directory to the top of the directory stack, or rotates
    the stack, making the new top of the stack the current working
    directory.
    Exit Status:
    Returns success unless an invalid argument is supplied or the directory
    change fails.`
    ]
  ],
  [
    "pwd",
    [
      "pwd [-LP]",
      `Print the name of the current working directory.

    Options:
      -L	print the value of $PWD if it names the current working
    	directory
      -P	print the physical directory, without any symbolic links

    By default, \`pwd' behaves as if \`-L' were specified.
    Exit Status:
    Returns 0 unless an invalid option is given or the current directory
    cannot be read.`
    ]
  ],
  [
    "read",
    [
      "read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]",
      `Read a line from the standard input and split it into fields.
    Reads a single line from the standard input, or from file descriptor FD
    if the -u option is supplied.  The line is split into fields as with word
    splitting, and the first word is assigned to the first NAME, the second
    word to the second NAME, and so on, with any leftover words assigned to
    the last NAME.
    Exit Status:
    The return code is zero, unless end-of-file is encountered, read times out,
    or an invalid file descriptor is supplied as the argument to -u.`
    ]
  ],
  [
    "readarray",
    [
      "readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]",
      `Read lines from a file into an array variable.
    A synonym for \`mapfile'.`
    ]
  ],
  [
    "readonly",
    [
      "readonly [-aAf] [name[=value] ...] or readonly -p",
      `Mark shell variables as unchangeable.
    Mark each NAME as read-only; the values of these NAMEs may not be
    changed by subsequent assignment.
    Exit Status:
    Returns success unless an invalid option is given or NAME is invalid.`
    ]
  ],
  [
    "return",
    [
      "return [n]",
      `Return from a shell function.
    Causes a function or sourced script to exit with the return value
    specified by N.  If N is omitted, the return status is that of the
    last command executed within the function or script.
    Exit Status:
    Returns N, or failure if the shell is not executing a function or script.`
    ]
  ],
  [
    "set",
    [
      "set [-abefhkmnptuvxBCHP] [-o option-name] [--] [arg ...]",
      `Set or unset values of shell options and positional parameters.
    Change the value of shell attributes and positional parameters, or
    display the names and values of shell variables.

    Options:
      -e  Exit immediately if a command exits with a non-zero status.
      -u  Treat unset variables as an error when substituting.
      -x  Print commands and their arguments as they are executed.
      -o option-name
          Set the variable corresponding to option-name

    Exit Status:
    Returns success unless an invalid option is given.`
    ]
  ],
  [
    "shift",
    [
      "shift [n]",
      `Shift positional parameters.
    Rename the positional parameters $N+1,$N+2 ... to $1,$2 ...  If N is
    not given, it is assumed to be 1.
    Exit Status:
    Returns success unless N is negative or greater than $#.`
    ]
  ],
  [
    "shopt",
    [
      "shopt [-pqsu] [-o] [optname ...]",
      `Set and unset shell options.
    Change the setting of each shell option OPTNAME.  Without any option
    arguments, list each supplied OPTNAME, or all shell options if no
    OPTNAMEs are given, with an indication of whether or not each is set.

    Options:
      -o	restrict OPTNAMEs to those defined for use with \`set -o'
      -p	print each shell option with an indication of its status
      -q	suppress output
      -s	enable (set) each OPTNAME
      -u	disable (unset) each OPTNAME

    Exit Status:
    Returns success if OPTNAME is enabled; fails if an invalid option is
    given or OPTNAME is disabled.`
    ]
  ],
  [
    "source",
    [
      "source filename [arguments]",
      `Execute commands from a file in the current shell.
    Read and execute commands from FILENAME in the current shell.
    The entries in $PATH are used to find the directory containing FILENAME.
    Exit Status:
    Returns the status of the last command executed in FILENAME.`
    ]
  ],
  [
    "suspend",
    [
      "suspend [-f]",
      `Suspend shell execution.
    Suspend the execution of this shell until it receives a SIGCONT signal.`
    ]
  ],
  [
    "test",
    [
      "test [expr]",
      `Evaluate conditional expression.
    Exits with a status of 0 (true) or 1 (false) depending on
    the evaluation of EXPR.  Expressions may be unary or binary.
    Exit Status:
    Returns success if EXPR evaluates to true; fails if EXPR evaluates to
    false or an invalid argument is given.`
    ]
  ],
  [
    "times",
    [
      "times",
      `Display process times.
    Prints the accumulated user and system times for the shell and all of its
    child processes.
    Exit Status:
    Always succeeds.`
    ]
  ],
  [
    "trap",
    [
      "trap [-lp] [[arg] signal_spec ...]",
      `Trap signals and other events.
    Defines and activates handlers to be run when the shell receives signals
    or other conditions.
    Exit Status:
    Returns success unless a SIGSPEC is invalid or an invalid option is given.`
    ]
  ],
  [
    "true",
    [
      "true",
      `Return a successful result.
    Exit Status:
    Always succeeds.`
    ]
  ],
  [
    "type",
    [
      "type [-afptP] name [name ...]",
      `Display information about command type.
    For each NAME, indicate how it would be interpreted if used as a
    command name.

    Options:
      -a	display all locations containing an executable named NAME
      -f	suppress shell function lookup
      -P	force a PATH search for each NAME, even if it is an alias,
    	builtin, or function, and returns the name of the disk file
    	that would be executed
      -p	returns either the name of the disk file that would be executed,
    	or nothing if \`type -t NAME' would not return \`file'
      -t	output a single word which is one of \`alias', \`keyword',
    	\`function', \`builtin', \`file' or \`', if NAME is an alias,
    	shell reserved word, shell function, shell builtin, disk file,
    	or not found, respectively

    Exit Status:
    Returns success if all of the NAMEs are found; fails if any are not found.`
    ]
  ],
  [
    "typeset",
    [
      "typeset [-aAfFgilnrtux] [-p] name[=value] ...",
      `Set variable values and attributes.
    A synonym for \`declare'.`
    ]
  ],
  [
    "ulimit",
    [
      "ulimit [-SHabcdefiklmnpqrstuvxPT] [limit]",
      `Modify shell resource limits.
    Provides control over the resources available to the shell and processes
    it creates, on systems that allow such control.
    Exit Status:
    Returns success unless an invalid option is supplied or an error occurs.`
    ]
  ],
  [
    "umask",
    [
      "umask [-p] [-S] [mode]",
      `Display or set file mode mask.
    Sets the user file-creation mask to MODE.  If MODE is omitted, prints
    the current value of the mask.
    Exit Status:
    Returns success unless MODE is invalid or an invalid option is given.`
    ]
  ],
  [
    "unalias",
    [
      "unalias [-a] name [name ...]",
      `Remove each NAME from the list of defined aliases.
    Exit Status:
    Returns success unless a NAME is not an existing alias.`
    ]
  ],
  [
    "unset",
    [
      "unset [-f] [-v] [-n] [name ...]",
      `Unset values and attributes of shell variables and functions.
    For each NAME, remove the corresponding variable or function.

    Options:
      -f	treat each NAME as a shell function
      -v	treat each NAME as a shell variable
      -n	treat each NAME as a name reference and unset the variable itself
    	rather than the variable it references

    Without options, unset first tries to unset a variable, and if that fails,
    tries to unset a function.
    Exit Status:
    Returns success unless an invalid option is given or a NAME is read-only.`
    ]
  ],
  [
    "wait",
    [
      "wait [-fn] [id ...]",
      `Wait for job completion and return exit status.
    Waits for each process identified by an ID, which may be a process ID or a
    job specification, and reports its termination status.
    Exit Status:
    Returns the status of the last ID; fails if ID is invalid or an invalid
    option is given.`
    ]
  ]
]);

// All builtin names for listing
const ALL_BUILTINS = [...BUILTIN_HELP.keys()].sort();

export function handleHelp(
  _ctx: InterpreterContext,
  args: string[]
): ExecResult {
  let shortForm = false;
  const patterns: string[] = [];

  // Parse arguments
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      // Remaining args are patterns
      while (i < args.length) {
        patterns.push(args[i]);
        i++;
      }
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "s") {
          shortForm = true;
        } else {
          return failure(`bash: help: -${flag}: invalid option\n`, 2);
        }
      }
      i++;
    } else {
      patterns.push(arg);
      i++;
    }
  }

  // No patterns: list all builtins
  if (patterns.length === 0) {
    return listAllBuiltins();
  }

  // With patterns: show help for matching builtins
  let stdout = "";
  let hasError = false;
  let stderr = "";

  for (const pattern of patterns) {
    const matches = findMatchingBuiltins(pattern);

    if (matches.length === 0) {
      stderr += `bash: help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.\n`;
      hasError = true;
      continue;
    }

    for (const name of matches) {
      // Use Object.hasOwn to prevent prototype pollution
      const entry = BUILTIN_HELP.get(name);
      if (!entry) continue;
      const [synopsis, description] = entry;
      if (shortForm) {
        stdout += `${name}: ${synopsis}\n`;
      } else {
        stdout += `${name}: ${synopsis}\n${description}\n`;
      }
    }
  }

  return {
    exitCode: hasError ? 1 : 0,
    stdout,
    stderr
  };
}

/**
 * Find builtins matching a pattern (supports glob-style wildcards)
 */
function findMatchingBuiltins(pattern: string): string[] {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars except * and ?
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const regex = createUserRegex(`^${regexPattern}$`);
  return ALL_BUILTINS.filter((name) => regex.test(name));
}

/**
 * List all builtins in a formatted table
 */
function listAllBuiltins(): ExecResult {
  const lines: string[] = [];

  lines.push("@cloudflare/shell builtins");
  lines.push(
    "These shell commands are defined internally. Type `help' to see this list."
  );
  lines.push("Type `help name' to find out more about the function `name'.");
  lines.push("");

  // Create two-column output with builtin names
  const maxWidth = 36;
  const builtins = ALL_BUILTINS.slice();

  // Build pairs for two-column display
  const midpoint = Math.ceil(builtins.length / 2);
  for (let i = 0; i < midpoint; i++) {
    const left = builtins[i] || "";
    const right = builtins[i + midpoint] || "";
    const leftPadded = left.padEnd(maxWidth);
    lines.push(right ? `${leftPadded}${right}` : left);
  }

  return success(`${lines.join("\n")}\n`);
}
