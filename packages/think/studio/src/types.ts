/** A resolved connection the Studio uses to drive `useAgent`. */
export interface StudioConnection {
  /** Remote origin, e.g. `https://app.example.com` (takes precedence). */
  url?: string;
  /** Local host[:port], e.g. `localhost:5173`. */
  host?: string;
  /** Override the derived protocol. */
  protocol?: "ws" | "wss";
  /** Auth token, sent as the `token` query param. */
  token?: string;
  /** Agent id/segment to connect to. */
  agent: string;
  /** Agent instance name. */
  instance: string;
  /** Route prefix (default `agents`). */
  routePrefix?: string;
  /** Whether `agent` is a canonical manifest id (used verbatim). */
  canonicalAgent: boolean;
}
