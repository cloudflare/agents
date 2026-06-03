import { launch as rawLaunch } from "@cloudflare/playwright";

const TIMEOUT_MS = 60_000;

const logs = [];
const console = createCapturedConsole(logs);
void console;
const userFn = /* __USER_CODE__ */ undefined;

export default {
  async fetch(_request, env) {
    const browser = await rawLaunch(env.BROWSER);

    if (typeof userFn !== "function") {
      return Response.json({
        error: "User code must evaluate to a function",
        logs
      });
    }

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Execution timed out")), TIMEOUT_MS);
    });

    let result;
    let runError;
    try {
      result = await Promise.race([userFn({ browser }), timeout]);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    }

    try {
      await browser.close();
    } catch (error) {
      runError ??= error instanceof Error ? error.message : String(error);
    }

    return Response.json(
      runError
        ? { error: runError, logs }
        : { result: encodeValue(result), logs }
    );
  }
};

function encodeValue(value) {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (let i = 0; i < value.byteLength; i++) {
      binary += String.fromCharCode(value[i]);
    }
    return {
      __dynamic_playwright_binary_v1__: "Uint8Array",
      data: btoa(binary)
    };
  }
  if (value instanceof ArrayBuffer) {
    return encodeValue(new Uint8Array(value));
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = encodeValue(nested);
    }
    return out;
  }
  return value;
}

function createCapturedConsole(logs) {
  const format = (args) =>
    args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  return {
    log: (...args) => logs.push(format(args)),
    warn: (...args) => logs.push("[warn] " + format(args)),
    error: (...args) => logs.push("[error] " + format(args))
  };
}
