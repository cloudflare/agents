import puppeteer from "@cloudflare/puppeteer";
import userFn from "./user.js";

const TIMEOUT_MS = 60_000;

const logs = [];
globalThis.console = createCapturedConsole(logs);

export default {
  async fetch(_request, env) {
    const browserResult = await createBrowserOrReturnError(env);
    if (browserResult instanceof Response) return browserResult;
    const { browser, sessionId } = browserResult;
    const page = await getOrCreatePage(browser);

    if (typeof userFn !== "function") {
      return Response.json({
        error: "User module must default-export a function",
        logs
      });
    }

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Execution timed out")), TIMEOUT_MS);
    });

    let result;
    let runError;
    try {
      result = await Promise.race([userFn({ page }), timeout]);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      browser.disconnect();
    }

    return Response.json(
      runError
        ? { error: runError, logs, sessionId }
        : { result: encodeValue(result), logs, sessionId }
    );
  }
};

async function createBrowserOrReturnError(env) {
  const sessionId = env.SESSION_ID;
  try {
    console.log("Connecting to Browser Run session", sessionId);
    const browser = await puppeteer.connect(env.BROWSER, sessionId);
    return { browser, sessionId };
  } catch (error) {
    const diagnostics = sessionId ? await inspectSession(env, sessionId) : null;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create Browser Run client", {
      sessionId,
      message,
      diagnostics
    });

    return Response.json(
      {
        error: env.SESSION_ID
          ? `Failed to connect to Browser Run session ${sessionId}: ${message}`
          : `Failed to launch Browser Run session: ${message}`,
        logs,
        sessionId,
        diagnostics: {
          phase: env.SESSION_ID ? "connect" : "launch",
          sessionId,
          error: serializeError(error),
          browserRun: diagnostics
        }
      },
      { status: 500 }
    );
  }
}

async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  return pages[0] ?? (await browser.newPage());
}

async function inspectSession(env, sessionId) {
  try {
    const response = await env.BROWSER.fetch(
      `http://fake.host/v1/devtools/browser/${sessionId}/json/list`
    );
    return {
      targetListStatus: response.status,
      targetListOk: response.ok,
      targets: response.ok ? await response.json() : await response.text()
    };
  } catch (error) {
    return {
      targetListError: serializeError(error)
    };
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

function encodeValue(value) {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (let i = 0; i < value.byteLength; i++) {
      binary += String.fromCharCode(value[i]);
    }
    return {
      __dynamic_puppeteer_binary_v1__: "Uint8Array",
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
