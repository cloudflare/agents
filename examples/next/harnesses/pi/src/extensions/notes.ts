import type { PiExtensionApi } from "../harness/types";

/** Flag name toggled from the client, seeded from `PiHarnessConfig.flags`. */
export const CONFIRM_DESTRUCTIVE_FLAG = "confirm_destructive";

/** Custom entry type appended by `/note`; not part of the model's context. */
const NOTE_ENTRY_TYPE = "note";

/**
 * A slash command, a flag, and a blocking UI confirmation in one extension.
 *
 * - `/note <text>` appends a custom entry to the session and notifies the
 *   client. It runs out of band: no model turn, no durable operation.
 * - `confirm_destructive` is a boolean flag the client can toggle over the
 *   socket; while it is on, any `bash` command containing `rm ` waits for a
 *   `ctx.ui.confirm` answer from the browser before it runs, and a declined
 *   dialog blocks the tool call. With no client connected the dialog throws
 *   rather than answering for the absent user, and the throw blocks the
 *   call too — the reason then says nobody was there to ask, not that
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
    if (typeof command !== "string" || !command.includes("rm ")) {
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
