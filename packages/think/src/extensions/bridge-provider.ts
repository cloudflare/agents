/**
 * Bridge providers that adapt extension Worker RPC into Session's
 * ContextProvider / SkillProvider / WritableContextProvider interfaces.
 *
 * When an extension declares context blocks in its manifest, Think creates
 * a bridge provider for each block. The bridge delegates `get()`, `load()`,
 * and `set()` to the extension Worker's entrypoint via RPC.
 *
 * This allows extensions to contribute context blocks to the Session's
 * system prompt without Session knowing about the extension system.
 */

interface ExtensionContextEntrypoint {
  contextGet(label: string): Promise<string | null>;
  contextLoad?(label: string, key: string): Promise<string | null>;
  contextSet?(
    label: string,
    key: string,
    content: string,
    description?: string
  ): Promise<void>;
}

/**
 * A readonly context provider backed by an extension Worker.
 * Delegates `get()` to the extension's `contextGet` RPC method.
 */
export class ExtensionContextBridge {
  protected _label: string;
  protected _entrypoint: ExtensionContextEntrypoint;

  constructor(label: string, entrypoint: ExtensionContextEntrypoint) {
    this._label = label;
    this._entrypoint = entrypoint;
  }

  init(_label: string): void {}

  async get(): Promise<string | null> {
    return this._entrypoint.contextGet(this._label);
  }
}

/**
 * A writable context provider backed by an extension Worker.
 * Delegates `get()` and `set()` to the extension's RPC methods.
 */
export class ExtensionWritableBridge extends ExtensionContextBridge {
  async set(content: string): Promise<void> {
    await this._entrypoint.contextSet?.(this._label, "", content);
  }
}

/**
 * A skill provider backed by an extension Worker.
 * Delegates `get()`, `load()`, and optionally `set()` to the extension's RPC methods.
 */
export class ExtensionSkillBridge extends ExtensionContextBridge {
  async load(key: string): Promise<string | null> {
    return (await this._entrypoint.contextLoad?.(this._label, key)) ?? null;
  }

  async set(key: string, content: string, description?: string): Promise<void> {
    await this._entrypoint.contextSet?.(this._label, key, content, description);
  }
}

/**
 * Create the appropriate bridge provider based on the context block type.
 */
export function createBridgeProvider(
  label: string,
  type: "readonly" | "writable" | "skill" | "searchable",
  entrypoint: ExtensionContextEntrypoint
) {
  switch (type) {
    case "skill":
      return new ExtensionSkillBridge(label, entrypoint);
    case "writable":
      return new ExtensionWritableBridge(label, entrypoint);
    case "readonly":
    case "searchable":
    default:
      return new ExtensionContextBridge(label, entrypoint);
  }
}
