// Side-effect module for the `wrangler dev` chaos e2e tests. Import it (for its
// side effects) at the top of any suite that SIGKILLs/restarts the worker
// mid-request.
//
// undici's `writeH1` calls `socket.setTypeOfService(...)` on every request when
// the socket exposes that method. Against a server being torn down the
// underlying `setsockopt(IP_TOS)` syscall returns EINVAL, which Node throws
// *synchronously* inside undici — there is no `fetch`/WebSocket call site that
// can catch it, so it surfaces as an unhandled exception and fails an
// otherwise-green run. We never use IP type-of-service in these probes, so make
// the optional setter best-effort: still apply it on healthy sockets, swallow
// the benign teardown EINVAL.
//
// This complements the per-suite `setDefaultAutoSelectFamily(false)` call, which
// only addresses the *connect-time* happy-eyeballs variant of the same hazard.
import { Socket } from "node:net";

const proto = Socket.prototype as unknown as {
  setTypeOfService?: (tos: number) => unknown;
};
const original = proto.setTypeOfService;
if (typeof original === "function") {
  proto.setTypeOfService = function (this: unknown, tos: number) {
    try {
      return original.call(this, tos);
    } catch {
      return this;
    }
  };
}
