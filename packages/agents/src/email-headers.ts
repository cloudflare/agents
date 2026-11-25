/**
 * Reply headers shared by `Agent.replyToEmail` and the Channels email
 * Channel.
 *
 * @internal
 */

/** The longest header value a reply carries (`In-Reply-To`, `References`). */
export const EMAIL_HEADER_VALUE_LIMIT = 2048;

const encoder = new TextEncoder();

/** A reply's subject: `Re: ` once, never `Re: Re: `. @internal */
export function replySubject(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * The message ids (without brackets) a `References` header keeps: the
 * thread's root first, then the newest that fit within the header limit.
 * Empty when not even the root fits. @internal
 */
export function boundedReferences(references: readonly string[]): string[] {
  const unique = [...new Set(references.filter(Boolean))];
  if (unique.length === 0) return [];
  const header = (ids: readonly string[]) =>
    encoder.encode(ids.map((id) => `<${id}>`).join(" ")).byteLength;
  if (header([unique[0]]) > EMAIL_HEADER_VALUE_LIMIT) return [];
  const selected = [unique[0]];
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const candidate = unique[index];
    if (header([...selected, candidate]) <= EMAIL_HEADER_VALUE_LIMIT) {
      selected.splice(1, 0, candidate);
    }
  }
  return selected;
}

/** The `References` header for these message ids, bounded as above. @internal */
export function referencesHeader(
  references: readonly string[]
): string | undefined {
  const kept = boundedReferences(references);
  return kept.length > 0 ? kept.map((id) => `<${id}>`).join(" ") : undefined;
}
