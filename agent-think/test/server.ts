import { setupServer } from "msw/node";

// A request-mocking server with NO default handlers. The point isn't to stub
// GitHub or Workers AI here (those calls only happen inside a real container
// turn, which this suite deliberately skips) — it's a tripwire: paired with
// `onUnhandledRequest: "error"` in setup.ts, any outbound fetch this suite
// makes by accident fails the test loudly instead of silently hitting the
// network. Individual tests can `server.use(...)` to add handlers if they ever
// need to assert on a specific outbound call.
export const server = setupServer();
