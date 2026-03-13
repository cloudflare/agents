/**
 * Embedded Adapters
 *
 * Self-contained code execution using WASM-based interpreters.
 * Works everywhere — Workers, Node.js, Deno, browsers — with no
 * platform-specific dependencies.
 *
 * Import from "@cloudflare/shell/embedded".
 *
 * @example
 * ```ts
 * import { getQuickJS } from "quickjs-emscripten";
 * import { Shell } from "@cloudflare/shell";
 * import { EmbeddedExecutor } from "@cloudflare/shell/embedded";
 *
 * const QuickJS = await getQuickJS();
 * const shell = new Shell({
 *   executor: new EmbeddedExecutor({ quickjs: QuickJS }),
 * });
 * await shell.exec('js-exec "console.log(1+1)"');
 * ```
 */

import type { CodeExecutor } from "./interfaces";

// ── QuickJS "Like" interfaces ─────────────────────────────────────
//
// Minimal subset of quickjs-emscripten's API.
// Users must install quickjs-emscripten as a peer dependency.

/**
 * The subset of QuickJSWASMModule we need.
 * Matches the convenience `evalCode` method on the module singleton.
 */
export interface QuickJSWASMModuleLike {
  evalCode(
    code: string,
    options?: {
      memoryLimitBytes?: number;
      shouldInterrupt?: () => boolean | undefined;
    }
  ): unknown;
}

// ── Pyodide "Like" interface ──────────────────────────────────────
//
// Minimal subset of Pyodide's API.
// Users must install pyodide as a peer dependency.

/**
 * The subset of the Pyodide runtime we need.
 * Matches the object returned by `loadPyodide()`.
 */
export interface PyodideLike {
  runPython(code: string): unknown;
}

// ── EmbeddedExecutor ──────────────────────────────────────────────

/**
 * Implements CodeExecutor using embedded WASM interpreters.
 *
 * - JavaScript: QuickJS (via quickjs-emscripten) — ~500KB WASM
 * - Python: Pyodide (CPython compiled to WASM) — ~10MB+
 *
 * Both engines are optional. Provide one or both depending on which
 * languages you need. An error is thrown if code is executed in a
 * language whose engine wasn't provided.
 *
 * @example
 * ```ts
 * import { getQuickJS } from "quickjs-emscripten";
 * import { loadPyodide } from "pyodide";
 * import { EmbeddedExecutor } from "@cloudflare/shell/embedded";
 *
 * const executor = new EmbeddedExecutor({
 *   quickjs: await getQuickJS(),
 *   pyodide: await loadPyodide(),
 * });
 * ```
 */
export class EmbeddedExecutor implements CodeExecutor {
  private readonly quickjs?: QuickJSWASMModuleLike;
  private readonly pyodide?: PyodideLike;
  private readonly memoryLimitBytes: number;
  private readonly maxExecutionMs: number;

  constructor(options: {
    quickjs?: QuickJSWASMModuleLike;
    pyodide?: PyodideLike;
    /** Memory limit for QuickJS execution (default: 256 MB) */
    memoryLimitBytes?: number;
    /** Maximum execution time in milliseconds (default: 30s) */
    maxExecutionMs?: number;
  }) {
    this.quickjs = options.quickjs;
    this.pyodide = options.pyodide;
    this.memoryLimitBytes = options.memoryLimitBytes ?? 256 * 1024 * 1024;
    this.maxExecutionMs = options.maxExecutionMs ?? 30_000;
  }

  async execute(
    code: string,
    language: "javascript" | "python",
    options?: { stdin?: string; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (language === "javascript") {
      return this.executeJS(code, options);
    }
    if (language === "python") {
      return this.executePython(code, options);
    }
    return {
      stdout: "",
      stderr: `Unsupported language: ${language}\n`,
      exitCode: 1
    };
  }

  private executeJS(
    code: string,
    options?: { stdin?: string; env?: Record<string, string> }
  ): { stdout: string; stderr: string; exitCode: number } {
    if (!this.quickjs) {
      return {
        stdout: "",
        stderr:
          "QuickJS engine not provided. Pass { quickjs } to EmbeddedExecutor.\n",
        exitCode: 1
      };
    }

    // Build a wrapper script that:
    // 1. Defines console.log/error/warn/info to capture output
    // 2. Provides a minimal process.env
    // 3. Evaluates user code via new Function so console/process
    //    are passed as arguments (not relying on global scope)
    // 4. Returns captured output as a JSON string
    const envJson = JSON.stringify(options?.env ?? {});
    const codeJson = JSON.stringify(code);
    const wrapper = `(function(){
var __stdout=[];var __stderr=[];var __exitCode=0;
var __console={
log:function(){var p=[];for(var i=0;i<arguments.length;i++)p.push(String(arguments[i]));__stdout.push(p.join(" "))},
error:function(){var p=[];for(var i=0;i<arguments.length;i++)p.push(String(arguments[i]));__stderr.push(p.join(" "))},
warn:function(){var p=[];for(var i=0;i<arguments.length;i++)p.push(String(arguments[i]));__stderr.push(p.join(" "))},
info:function(){var p=[];for(var i=0;i<arguments.length;i++)p.push(String(arguments[i]));__stdout.push(p.join(" "))}
};
var __process={env:${envJson},argv:["quickjs","script.js"]};
try{(new Function("console","process",${codeJson}))(__console,__process)}catch(e){
__stderr.push(e&&e.stack?e.stack:e&&e.message?e.message:String(e));__exitCode=1}
return JSON.stringify({stdout:__stdout.join("\\n")+(__stdout.length?"\\n":""),stderr:__stderr.join("\\n")+(__stderr.length?"\\n":""),exitCode:__exitCode})
})()`;

    try {
      const deadline = Date.now() + this.maxExecutionMs;
      const resultJson = this.quickjs.evalCode(wrapper, {
        memoryLimitBytes: this.memoryLimitBytes,
        shouldInterrupt: () => Date.now() > deadline
      });

      if (typeof resultJson === "string") {
        return JSON.parse(resultJson) as {
          stdout: string;
          stderr: string;
          exitCode: number;
        };
      }

      // Unexpected return type — treat as empty success
      return { stdout: String(resultJson ?? ""), stderr: "", exitCode: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: "", stderr: msg + "\n", exitCode: 1 };
    }
  }

  private executePython(
    code: string,
    _options?: { stdin?: string; env?: Record<string, string> }
  ): { stdout: string; stderr: string; exitCode: number } {
    if (!this.pyodide) {
      return {
        stdout: "",
        stderr:
          "Pyodide engine not provided. Pass { pyodide } to EmbeddedExecutor.\n",
        exitCode: 1
      };
    }

    // Encode user code as base64 to avoid escaping issues when
    // embedding in the Python wrapper script.
    const codeBase64 = encodeBase64(code);

    const wrapper = `
import sys as __sys
import io as __io
import json as __json
import base64 as __base64
__stdout_buf = __io.StringIO()
__stderr_buf = __io.StringIO()
__old_stdout = __sys.stdout
__old_stderr = __sys.stderr
__sys.stdout = __stdout_buf
__sys.stderr = __stderr_buf
__exit_code = 0
try:
    __code = __base64.b64decode(b'${codeBase64}').decode('utf-8')
    exec(__code)
except SystemExit as __e:
    __exit_code = __e.code if isinstance(__e.code, int) else 1
except BaseException:
    import traceback as __tb
    __tb.print_exc(file=__stderr_buf)
    __exit_code = 1
finally:
    __sys.stdout = __old_stdout
    __sys.stderr = __old_stderr
__json.dumps({"stdout": __stdout_buf.getvalue(), "stderr": __stderr_buf.getvalue(), "exitCode": __exit_code})
`;

    try {
      const resultJson = this.pyodide.runPython(wrapper);
      if (typeof resultJson === "string") {
        return JSON.parse(resultJson) as {
          stdout: string;
          stderr: string;
          exitCode: number;
        };
      }
      return { stdout: String(resultJson ?? ""), stderr: "", exitCode: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: "", stderr: msg + "\n", exitCode: 1 };
    }
  }
}

/**
 * Encode a string to base64, handling Unicode correctly.
 * Works in all JS runtimes (Workers, Node.js, browsers).
 */
function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Re-export interfaces for convenience
export type { CodeExecutor };
