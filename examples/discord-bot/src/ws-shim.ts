// Chat SDK's Discord adapter imports the `ws` npm package for WebSocket.
// Workers already have WebSocket globally — this alias avoids bundling `ws`.
export const WebSocket = globalThis.WebSocket;
export default globalThis.WebSocket;
