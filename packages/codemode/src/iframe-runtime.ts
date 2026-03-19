/**
 * Self-contained runtime that boots inside the sandboxed iframe.
 *
 * The `iframeSandboxRuntimeMain` function is serialized via `.toString()`
 * and injected into the iframe's `srcdoc`. It MUST be fully self-contained —
 * no closures over module-level variables, no imported values at runtime.
 * (Type-only imports are safe because they are erased at compile time.)
 */

/**
 * The iframe-side runtime entry point.
 *
 * This function is stringified and injected into the iframe via srcdoc.
 * Everything it needs must be defined inside its own scope.
 */
function iframeSandboxRuntimeMain(): void {
  const runtimeWindow = window as Window &
    typeof globalThis & { __codemodeIframeInitialized?: boolean };

  if (runtimeWindow.__codemodeIframeInitialized) {
    return;
  }

  runtimeWindow.__codemodeIframeInitialized = true;

  const logs: string[] = [];
  const pending: Record<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  > = {};
  let nextId = 0;

  function post(message: unknown) {
    parent.postMessage(message, "*");
  }

  // Capture console output
  console.log = (...args: unknown[]) => {
    const values = [];
    for (let i = 0; i < args.length; i++) values.push(String(args[i]));
    logs.push(values.join(" "));
  };
  console.warn = (...args: unknown[]) => {
    const values = [];
    for (let i = 0; i < args.length; i++) values.push(String(args[i]));
    logs.push("[warn] " + values.join(" "));
  };
  console.error = (...args: unknown[]) => {
    const values = [];
    for (let i = 0; i < args.length; i++) values.push(String(args[i]));
    logs.push("[error] " + values.join(" "));
  };

  // Tool call proxy — sandbox code calls codemode.toolName(args)
  const codemode = new Proxy(
    {},
    {
      get: (_, toolName) => {
        return (args: unknown) => {
          const id = nextId++;
          return new Promise((resolve, reject) => {
            pending[id] = { resolve, reject };
            post({
              type: "tool-call",
              id,
              name: String(toolName),
              args: (args ?? {}) as Record<string, unknown>
            });
          });
        };
      }
    }
  );

  function isToolResultMessage(message: unknown): message is {
    type: "tool-result";
    id: number;
    result?: unknown;
    error?: string;
  } {
    if (typeof message !== "object" || message === null) return false;
    const candidate = message as Record<string, unknown>;
    return candidate.type === "tool-result" && typeof candidate.id === "number";
  }

  function isExecuteRequestMessage(
    message: unknown
  ): message is { type: "execute-request"; code: string } {
    if (typeof message !== "object" || message === null) return false;
    const candidate = message as Record<string, unknown>;
    return (
      candidate.type === "execute-request" && typeof candidate.code === "string"
    );
  }

  function executeCode(code: string) {
    try {
      const fn = new Function("codemode", "return (" + code + ")")(codemode);
      Promise.resolve(fn())
        .then((result: unknown) => {
          post({ type: "execution-result", result: { result, logs } });
        })
        .catch((err: Error) => {
          post({
            type: "execution-result",
            result: {
              result: undefined,
              error: err.message || String(err),
              logs
            }
          });
        });
    } catch (err) {
      post({
        type: "execution-result",
        result: {
          result: undefined,
          error: err instanceof Error ? err.message : String(err),
          logs
        }
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;

    const message = event.data;

    if (isToolResultMessage(message)) {
      const request = pending[message.id];
      if (!request) return;

      delete pending[message.id];
      if ("error" in message)
        request.reject(new Error(message.error as string));
      else request.resolve(message.result);
      return;
    }

    if (isExecuteRequestMessage(message)) {
      executeCode(message.code);
    }
  });

  post({ type: "sandbox-ready" });
}

/**
 * Returns a self-contained script string that boots the codemode iframe runtime.
 */
export function createIframeSandboxRuntimeScript(): string {
  return `;(${iframeSandboxRuntimeMain.toString()})();`;
}
