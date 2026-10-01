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
  let buffer = "";
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
   * Consumes whole lines out of the buffer. A buffer ending in a lone `\r` is
   * held back while more bytes may arrive, because the next byte decides
   * whether that `\r` was a CRLF pair or a bare-CR terminator.
   */
  const drain = (
    controller: TransformStreamDefaultController<string>,
    final: boolean
  ) => {
    for (;;) {
      const match = /\r\n|[\r\n]/.exec(buffer);
      if (match === null) break;
      const end = match.index + match[0].length;
      if (!final && match[0] === "\r" && end === buffer.length) break;
      consumeLine(buffer.slice(0, match.index), controller);
      buffer = buffer.slice(end);
    }
  };

  return new TransformStream<Uint8Array, string>({
    flush(controller) {
      buffer += decoder.decode();
      drain(controller, true);
      // A server that closed without a final blank line still owes us the
      // last event; emit whatever is left rather than dropping it.
      if (buffer !== "") {
        consumeLine(buffer, controller);
        buffer = "";
      }
      flushEvent(controller);
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller, false);
    }
  });
}
