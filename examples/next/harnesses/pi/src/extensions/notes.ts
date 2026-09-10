import type { PiExtensionApi } from "../harness/types";

/** Flag name toggled from the client, seeded from `PiHarnessConfig.flags`. */
export const CONFIRM_DESTRUCTIVE_FLAG = "confirm_destructive";

/** Custom entry type appended by `/note`; not part of the model's context. */
const NOTE_ENTRY_TYPE = "note";

/**
 * Command words the demo gate asks about.
 *
 * A deliberately short, documented list rather than a general model of what a
 * shell can destroy: see {@link isDestructiveCommand} for why the list not
 * being exhaustive is fine here.
 */
const DESTRUCTIVE_COMMANDS = new Set([
  "dd",
  "mv",
  "rm",
  "rmdir",
  "shred",
  "truncate",
  "unlink"
]);

/**
 * Commands that run another command, so the words after them are commands
 * too. `find . | xargs rm -rf` puts `rm` nowhere near a command position.
 */
const COMMAND_WRAPPERS = new Set([
  "bash",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sh",
  "sudo",
  "time",
  "timeout",
  "xargs"
]);

/** Marker standing in for a shell operator once the command is split up. */
const COMMAND_BREAK = "\u0000";

/** Operators that end one command and put the next word in command position. */
const COMMAND_OPERATORS = /\$\(|[;\n|&`()]/g;

/** A `VAR=value` prefix, which precedes the command rather than being one. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether any *command word* in `command` names something destructive.
 *
 * **This is a demo gate for the confirmation dialog, not a security
 * boundary.** It exists to make `ctx.ui.confirm` easy to try from the
 * browser, and a shell has endless ways past a word list — `eval`, an
 * expansion that spells the name out, a script the model writes and then
 * runs. The real safety property is elsewhere and does not depend on this
 * function at all: the bash tool runs in an in-isolate interpreter over the
 * Durable Object's own sandboxed `Workspace`, so the worst a command can
 * reach is the session's own virtual filesystem. Nothing here guards a real
 * machine, because there is no real machine behind it.
 *
 * It does look at command words rather than at the raw text, which the
 * literal `rm ` this started as did not: that matched `echo "rm -rf /"`,
 * missed a trailing `rm -rf x` with no space after it, and never saw
 * `find . | xargs rm`. Splitting on the shell's operators and asking which
 * words sit in command position costs about as much and is wrong less often.
 *
 * Exported for the tests, which are the only reason it is not local.
 */
export function isDestructiveCommand(command: string): boolean {
  const tokens = command
    .replace(COMMAND_OPERATORS, ` ${COMMAND_BREAK} `)
    .split(/\s+/);
  // The first word of the line is a command; after an operator, so is the
  // next one. Anything else is an argument — `echo rm` runs `echo`.
  let commandPosition = true;
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (token === COMMAND_BREAK) {
      commandPosition = true;
      continue;
    }
    if (!commandPosition) continue;
    // Quotes are the shell's, not part of the name: `sh -c "rm -rf /"`.
    // A path is stripped to its last segment: `/bin/rm` is `rm`.
    const word = token.replace(/^["']+|["']+$/g, "").replace(/^.*\//, "");
    if (DESTRUCTIVE_COMMANDS.has(word)) return true;
    // A wrapper, an option or an environment assignment leaves the command
    // still to come, so the following words stay candidates.
    if (COMMAND_WRAPPERS.has(word)) continue;
    if (word.startsWith("-") || ENV_ASSIGNMENT.test(word)) continue;
    commandPosition = false;
  }
  return false;
}

/**
 * A slash command, a flag, and a blocking UI confirmation in one extension.
 *
 * - `/note <text>` appends a custom entry to the session and notifies the
 *   client. It runs out of band: no model turn, no durable operation.
 * - `confirm_destructive` is a boolean flag the client can toggle over the
 *   socket; while it is on, a `bash` command whose command words name
 *   something destructive ({@link isDestructiveCommand} — a demo gate, not a
 *   security boundary) waits for a `ctx.ui.confirm` answer from the browser
 *   before it runs, and a declined dialog blocks the tool call. With no
 *   client connected the dialog throws rather than answering for the absent
 *   user, and the throw blocks the call too — the reason then says nobody was there to ask, not that
 *   somebody declined.
 */
export function notes(pi: PiExtensionApi): void {
  pi.registerFlag(CONFIRM_DESTRUCTIVE_FLAG, {
    type: "boolean",
    default: false,
    description: "Ask before the bash tool runs a destructive command."
  });

  pi.registerCommand(NOTE_ENTRY_TYPE, {
    description: "Append a note to this session without asking the model.",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (text.length === 0) {
        ctx.ui.notify("Usage: /note <text>", "warning");
        return;
      }
      pi.appendEntry(NOTE_ENTRY_TYPE, { text, at: Date.now() });
      ctx.ui.notify(`Noted: ${text}`);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    if (pi.getFlag(CONFIRM_DESTRUCTIVE_FLAG) !== true) return undefined;
    // `toolName: "bash"` does not narrow away pi's custom-tool variant.
    const command = (event.input as { readonly command?: unknown }).command;
    if (typeof command !== "string" || !isDestructiveCommand(command)) {
      return undefined;
    }
    const approved = await ctx.ui.confirm(
      "Run a destructive command?",
      command
    );
    return approved
      ? undefined
      : { block: true, reason: "The user declined the command." };
  });
}
