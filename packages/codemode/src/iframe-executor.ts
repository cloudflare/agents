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
import type {
  ExecuteResult,
  Executor,
  ResolvedProvider
} from "./executor-types";
import { createIframeSandboxRuntimeScript } from "./iframe-runtime";
import { normalizeCode } from "./normalize";
import { sanitizeToolName } from "./utils";

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
  nonce: string,
  id: number,
  value: unknown,
  isError: boolean
): ToolResultSuccessMessage | ToolResultErrorMessage {
  if (isError) {
    return {
      type: "tool-result",
      nonce,
      id,
      error: value instanceof Error ? value.message : String(value)
    };
  }
  return { type: "tool-result", nonce, id, result: value };
}

function createExecutionNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
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
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    let providers: ResolvedProvider[];
    if (!Array.isArray(providersOrFns)) {
      console.warn(
        "[@cloudflare/codemode] Passing raw fns to executor.execute() is deprecated. " +
          "Use ResolvedProvider[] instead. This will be removed in the next major version."
      );
      providers = [{ name: "codemode", fns: providersOrFns }];
    } else {
      providers = providersOrFns;
    }

    const reservedNames = new Set(["__dispatchers", "__logs"]);
    const validIdent = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const seenNames = new Set<string>();
    for (const provider of providers) {
      if (reservedNames.has(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is reserved`
        };
      }
      if (!validIdent.test(provider.name)) {
        return {
          result: undefined,
          error: `Provider name "${provider.name}" is not a valid JavaScript identifier`
        };
      }
      if (seenNames.has(provider.name)) {
        return {
          result: undefined,
          error: `Duplicate provider name "${provider.name}"`
        };
      }
      seenNames.add(provider.name);
    }

    const normalizedCode = normalizeCode(code);
    const resolvedProviders: ResolvedProvider[] = [];
    for (const provider of providers) {
      const sanitizedFns: Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      > = {};
      const sanitizedNames = new Map<string, string>();
      for (const [name, fn] of Object.entries(provider.fns)) {
        const sanitizedName = sanitizeToolName(name);
        const existingName = sanitizedNames.get(sanitizedName);
        if (existingName && existingName !== name) {
          return {
            result: undefined,
            error:
              `Tool names "${existingName}" and "${name}" both sanitize to ` +
              `"${sanitizedName}" in provider "${provider.name}"`
          };
        }
        sanitizedNames.set(sanitizedName, name);
        sanitizedFns[sanitizedName] = fn;
      }
      const resolved: ResolvedProvider = {
        name: provider.name,
        fns: sanitizedFns
      };
      if (provider.positionalArgs) resolved.positionalArgs = true;
      resolvedProviders.push(resolved);
    }
    const providerMap = new Map(
      resolvedProviders.map((provider) => [provider.name, provider] as const)
    );
    const nonce = createExecutionNonce();

    const executeRequest: ExecuteRequestMessage = {
      type: "execute-request",
      nonce,
      code: normalizedCode,
      providers: resolvedProviders.map((provider) => {
        if (provider.positionalArgs) {
          return { name: provider.name, positionalArgs: true };
        }
        return { name: provider.name };
      })
    };

    const invokeProviderTool = async (
      provider: ResolvedProvider,
      args: unknown,
      name: string
    ) => {
      const fn = provider.fns[name];
      if (!fn) {
        throw new Error(`Tool "${name}" not found`);
      }
      if (!provider.positionalArgs) {
        return fn(args);
      }
      const positionalArgs = Array.isArray(args) ? args : [args];
      return fn(...positionalArgs);
    };

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
      const warnedInvalidNonceTypes = new Set<string>();

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

      const warnInvalidNonce = (messageType: string) => {
        if (warnedInvalidNonceTypes.has(messageType)) return;
        warnedInvalidNonceTypes.add(messageType);
        console.warn(
          `[@cloudflare/codemode] Ignoring sandbox ${messageType} message with invalid execution nonce`
        );
      };

      const handler = async (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;

        const data: unknown = event.data;

        if (isSandboxReadyMessage(data)) {
          if (ready) return;
          ready = true;
          postToChild(executeRequest);
          return;
        }

        if (isToolCallMessage(data)) {
          if (data.nonce !== nonce) {
            warnInvalidNonce("tool-call");
            return;
          }
          const provider = providerMap.get(data.provider);
          if (!provider) {
            postToChild(
              createToolResultMessage(
                nonce,
                data.id,
                `Provider "${data.provider}" not found`,
                true
              )
            );
            return;
          }
          try {
            const result = await invokeProviderTool(
              provider,
              data.args,
              data.name
            );
            postToChild(createToolResultMessage(nonce, data.id, result, false));
          } catch (err) {
            postToChild(createToolResultMessage(nonce, data.id, err, true));
          }
          return;
        }

        if (isExecutionResultMessage(data)) {
          if (data.nonce !== nonce) {
            warnInvalidNonce("execution-result");
            return;
          }
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
