/**
 * How reply attachments reach a channel. An action attaches them with
 * `ctx.attachReply`; after the turn, each one is rendered to text and posted
 * to the active channel as an interim notice. Best-effort: a failure is
 * logged and never fails the turn.
 */

import type { ReplyAttachment } from "./actions";

type RenderedAttachment = string | { markdown: string } | undefined;

/**
 * The default text for a reply attachment, or `undefined` to skip it:
 * unknown types, and types a channel handles out of band (`voice_note`).
 */
export function defaultAttachmentText(
  attachment: ReplyAttachment
): RenderedAttachment {
  switch (attachment.type) {
    case "card":
      return {
        markdown: `\`\`\`json\n${JSON.stringify(
          (attachment as { payload: unknown }).payload,
          null,
          2
        )}\n\`\`\``
      };
    case "email_draft": {
      const draft = attachment as { subject?: string; to?: string[] };
      const lines = ["**Email draft**"];
      if (draft.to?.length) lines.push(`To: ${draft.to.join(", ")}`);
      if (draft.subject) lines.push(`Subject: ${draft.subject}`);
      return { markdown: lines.join("\n") };
    }
    case "voice_note":
      return undefined;
    default:
      return undefined;
  }
}

/** Render each attachment and post it. Failures are logged and skipped. */
export async function deliverReplyAttachments(
  attachments: ReplyAttachment[] | undefined,
  render: (attachment: ReplyAttachment) => RenderedAttachment,
  post: (rendered: string | { markdown: string }) => Promise<void>
): Promise<void> {
  if (!attachments?.length) {
    return;
  }
  for (const attachment of attachments) {
    let rendered: RenderedAttachment;
    try {
      rendered = render(attachment);
    } catch (error) {
      console.warn(
        `[Think] renderAttachment threw: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (rendered === undefined) {
      continue;
    }
    try {
      await post(rendered);
    } catch (error) {
      console.warn(
        `[Think] failed to deliver channel attachment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
