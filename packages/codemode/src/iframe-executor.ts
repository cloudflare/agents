/**
 * IframeSandboxExecutor — a browser-native Executor that runs LLM-generated
 * code in a sandboxed iframe using postMessage for tool dispatch.
 *
 * Zero dependencies — uses only browser APIs (iframe, postMessage, CSP).
 */

import {
  type ExecuteRequestMessage,
  isExecutionResultMessage,
  isSandboxReadyMessage,
  isToolCallMessage,
  type ToolResultErrorMessage,
  type ToolResultSuccessMessage
} from "./messages";
import type { ExecuteResult, Executor } from "./executor";
import { createIframeSandboxRuntimeScript } from "./iframe-runtime";

export interface IframeSandboxExecutorOptions {
  /** Maximum execution time in milliseconds. Defaults to `30000`. */
  timeout?: number;
  /**
   * Content Security Policy applied to the iframe document.
   *
   * When omitted, defaults to a restrictive policy that only allows
   * inline scripts and eval (needed for code execution).
   */
  csp?: string;
}

const DEFAULT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';";
const DEFAULT_TIMEOUT = 30000;

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function buildSrcdoc(csp: string): string {
  const runtimeScript = escapeInlineScript(createIframeSandboxRuntimeScript());
  const safeCsp = escapeHtmlAttribute(csp);

  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${safeCsp}">
</head>
<body>
<script>
${runtimeScript}
</script>
</body>
</html>`;
}

function createToolResultMessage(
  id: number,
  value: unknown,
  isError: boolean
): ToolResultSuccessMessage | ToolResultErrorMessage {
  if (isError) {
    return {
      type: "tool-result",
      id,
      error: value instanceof Error ? value.message : String(value)
    };
  }
  return { type: "tool-result", id, result: value };
}

/**
 * Executes LLM-generated code in a browser iframe sandbox.
 *
 * For each execution, a hidden iframe is created with `sandbox="allow-scripts"`,
 * the runtime is injected via `srcdoc`, and the iframe is removed after completion.
 * Tool calls are dispatched via `postMessage`.
 */
export class IframeSandboxExecutor implements Executor {
  #timeout: number;
  #csp: string;

  constructor(options?: IframeSandboxExecutorOptions) {
    this.#timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.#csp = options?.csp ?? DEFAULT_CSP;
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-scripts");
    iframe.style.display = "none";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    iframe.srcdoc = buildSrcdoc(this.#csp);

    return new Promise<ExecuteResult>((resolve) => {
      let settled = false;
      let ready = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        iframe.removeEventListener("error", handleLoadError);
        iframe.remove();
      };

      const resolveError = (message: string) => {
        cleanup();
        resolve({ result: undefined, error: message, logs: [] });
      };

      const postToChild = (
        message:
          | ToolResultSuccessMessage
          | ToolResultErrorMessage
          | ExecuteRequestMessage
      ): boolean => {
        const child = iframe.contentWindow;
        if (!child) {
          resolveError("Sandbox iframe is not available");
          return false;
        }

        try {
          child.postMessage(message, "*");
          return true;
        } catch (err) {
          resolveError(err instanceof Error ? err.message : String(err));
          return false;
        }
      };

      const handler = async (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;

        const data: unknown = event.data;

        if (isSandboxReadyMessage(data)) {
          if (ready) return;
          ready = true;
          postToChild({ type: "execute-request", code });
          return;
        }

        if (isToolCallMessage(data)) {
          const fn = fns[data.name];
          if (!fn) {
            postToChild(
              createToolResultMessage(
                data.id,
                `Tool "${data.name}" not found`,
                true
              )
            );
            return;
          }
          try {
            const result = await fn(data.args);
            postToChild(createToolResultMessage(data.id, result, false));
          } catch (err) {
            postToChild(createToolResultMessage(data.id, err, true));
          }
          return;
        }

        if (isExecutionResultMessage(data)) {
          cleanup();
          resolve(data.result);
        }
      };

      const handleLoadError = () => {
        resolveError("Sandbox iframe failed to load");
      };

      window.addEventListener("message", handler);
      iframe.addEventListener("error", handleLoadError);

      const timer = setTimeout(() => {
        cleanup();
        resolve({ result: undefined, error: "Execution timed out", logs: [] });
      }, this.#timeout);

      document.body.appendChild(iframe);
    });
  }
}
