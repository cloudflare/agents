import { STATE_METHOD_NAMES } from "../backend";

export const STATE_RUNTIME_MODULE_ID = "state.js";

export function createStateModuleSource(): string {
  const members = STATE_METHOD_NAMES.map(
    (method) =>
      `    ${method}: (...args) => invoke(${JSON.stringify(method)}, ...args)`
  ).join(",\n");

  return [
    "export function createState(dispatcher) {",
    "  const invoke = async (method, ...args) => {",
    "    const resJson = await dispatcher.call(method, JSON.stringify(args));",
    "    const data = JSON.parse(resJson);",
    "    if (data.error) throw new Error(data.error);",
    "    return data.result;",
    "  };",
    "  return Object.freeze({",
    members,
    "  });",
    "}"
  ].join("\n");
}
