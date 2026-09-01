/** HTTP helpers for lazily serving offloaded session attachments. */

import { SessionAttachmentMissingError } from "./errors";
import type { Sessions } from "./sessions";

/** Options for {@link attachmentResponse}. */
export interface AttachmentResponseOptions {
  /** Additional response headers. Attachment metadata supplies defaults. */
  headers?: HeadersInit;
  /** Download instead of displaying supported media inline. */
  disposition?: "inline" | "attachment";
}

/**
 * Stream one attachment as an HTTP response without materializing its bytes.
 * Missing or malformed pointers return 404.
 */
export async function attachmentResponse(
  sessions: Sessions,
  hashOrUrl: string,
  options: AttachmentResponseOptions = {}
): Promise<Response> {
  try {
    const attachment = await sessions.attachments.get(hashOrUrl);
    if (!attachment)
      return new Response("Attachment not found", { status: 404 });
    const body = await sessions.attachments.open(hashOrUrl);
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", attachment.mediaType);
    }
    if (!headers.has("content-length")) {
      headers.set("content-length", String(attachment.bytes));
    }
    if (!headers.has("content-disposition")) {
      const disposition = options.disposition ?? "inline";
      const filename = attachment.filename
        ? `; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
        : "";
      headers.set("content-disposition", `${disposition}${filename}`);
    }
    return new Response(body, { headers });
  } catch (error) {
    if (error instanceof SessionAttachmentMissingError) {
      return new Response("Attachment not found", { status: 404 });
    }
    throw error;
  }
}
