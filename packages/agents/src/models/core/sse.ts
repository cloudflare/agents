/**
 * Decodes a `text/event-stream` byte stream into the `data` payload of each
 * event, as a `TransformStream` so the whole pipeline keeps backpressure and
 * nothing is ever buffered beyond the current event.
 *
 * Handles all three line terminators the SSE spec allows (LF, CRLF and a bare
 * CR), multi-line `data:` fields (joined with `\n`, per the spec), comment
 * lines (`:` prefixed), and non-`data` fields (`event:`, `id:`, `retry:`),
 * which are ignored. A trailing event that the server never terminated with a
 * blank line is still flushed.
 *
 * @experimental This surface is experimental and may change.
 */
export function sseDataStream(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();
  /** The incomplete last line, read once when its terminator arrives. */
  let pending = "";
  /** The last text ended in `\r`, so a leading `\n` completes that CRLF. */
  let skipLeadingLf = false;
  let data: string[] = [];

  const flushEvent = (controller: TransformStreamDefaultController<string>) => {
    if (data.length === 0) return;
    controller.enqueue(data.join("\n"));
    data = [];
  };

  const consumeLine = (
    line: string,
    controller: TransformStreamDefaultController<string>
  ) => {
    if (line === "") {
      flushEvent(controller);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  };

  /**
   * Consumes the whole lines `text` completes. Only the new text is scanned,
   * and an incomplete line is joined once, when it ends, so an event that
   * arrives in many chunks costs time linear in its size.
   */
  const decodeText = (
    text: string,
    controller: TransformStreamDefaultController<string>
  ) => {
    let start = skipLeadingLf && text.startsWith("\n") ? 1 : 0;
    if (text.length > 0) skipLeadingLf = false;
    for (let i = start; i < text.length; i++) {
      const char = text.charCodeAt(i);
      if (char !== 0x0a && char !== 0x0d) continue;
      consumeLine(pending + text.slice(start, i), controller);
      pending = "";
      if (char === 0x0d) {
        if (i + 1 === text.length) skipLeadingLf = true;
        else if (text.charCodeAt(i + 1) === 0x0a) i++;
      }
      start = i + 1;
    }
    pending += text.slice(start);
  };

  return new TransformStream<Uint8Array, string>({
    flush(controller) {
      decodeText(decoder.decode(), controller);
      // A server that closed without a final blank line still owes us the
      // last event; emit whatever is left rather than dropping it.
      if (pending !== "") {
        consumeLine(pending, controller);
        pending = "";
      }
      flushEvent(controller);
    },
    transform(chunk, controller) {
      decodeText(decoder.decode(chunk, { stream: true }), controller);
    }
  });
}
