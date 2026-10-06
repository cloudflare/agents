import { AsyncLocalStorage } from "node:async_hooks";
import { OpenCode } from "@opencode/client";

type OpenCodeMake = typeof OpenCode.make;
type OpenCodeFetch = NonNullable<Parameters<OpenCodeMake>[0]["fetch"]>;

// The workerd SDK gives its in-process HTTP handler to OpenCode.make but does
// not expose it. Capture that handler during boot so the CLI can reach it.
const captures = new AsyncLocalStorage<(fetch: OpenCodeFetch) => void>();
let installed = false;

function installCapture(): void {
  if (installed) return;
  const mutable = OpenCode as { make: OpenCodeMake };
  const original = mutable.make;
  const wrapped: OpenCodeMake = (options) => {
    if (options.fetch) captures.getStore()?.(options.fetch);
    return original(options);
  };
  try {
    Object.defineProperty(mutable, "make", {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: true
    });
  } catch (cause) {
    throw new Error("@opencode/client does not permit fetch capture", {
      cause
    });
  }
  if (mutable.make !== wrapped) {
    throw new Error("@opencode/client did not install fetch capture");
  }
  installed = true;
}

export async function captureOpenCodeFetch<
  Host extends { close(): Promise<void> }
>(create: () => Promise<Host>): Promise<{ host: Host; fetch: OpenCodeFetch }> {
  installCapture();
  let fetch: OpenCodeFetch | undefined;
  const host = await captures.run((captured) => {
    fetch = captured;
  }, create);
  if (!fetch) {
    await host.close();
    throw new Error(
      "@opencode/sdk used a different @opencode/client module instance"
    );
  }
  return { host, fetch };
}
