/**
 * Makes every WebSocket this process opens send these headers on the
 * upgrade. WebChannelClient takes only a URL, so this is the one place to add
 * them. Needs Node's WebSocket, which accepts an init object.
 */
export function sendHeadersOnUpgrade(headers: Record<string, string>): void {
  if (Object.keys(headers).length === 0) return;
  // SAFETY: Node's (undici's) WebSocket takes `{ protocols, headers }` in
  // place of the protocols argument.
  const Base = globalThis.WebSocket as unknown as new (
    url: string | URL,
    init: { protocols?: string | string[]; headers: Record<string, string> }
  ) => WebSocket;
  class HeaderWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { headers, ...(protocols !== undefined && { protocols }) });
    }
  }
  // SAFETY: a subclass with the same statics and instance interface.
  globalThis.WebSocket = HeaderWebSocket as unknown as typeof WebSocket;
}
