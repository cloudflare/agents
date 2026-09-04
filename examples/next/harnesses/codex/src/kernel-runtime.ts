import type {
  KernelCommand,
  KernelRuntime,
  KernelTransition
} from "./kernel-types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type KernelWasmExports = {
  readonly memory: WebAssembly.Memory;
  readonly alloc: (length: number) => number;
  readonly dealloc: (pointer: number, length: number) => void;
  readonly transition: (pointer: number, length: number) => bigint;
};

function exportsOf(instance: WebAssembly.Instance): KernelWasmExports {
  const candidate = instance.exports;
  if (
    !(candidate.memory instanceof WebAssembly.Memory) ||
    typeof candidate.alloc !== "function" ||
    typeof candidate.dealloc !== "function" ||
    typeof candidate.transition !== "function"
  ) {
    throw new Error("Codex kernel does not expose its expected ABI");
  }
  // SAFETY: Every field was checked immediately above. TypeScript's
  // WebAssembly export map cannot retain the checked function signatures.
  return candidate as unknown as KernelWasmExports;
}

function runTransition(
  instance: WebAssembly.Instance,
  command: KernelCommand
): KernelTransition {
  const wasm = exportsOf(instance);
  const input = encoder.encode(JSON.stringify(command));
  const inputPointer = wasm.alloc(input.byteLength);
  try {
    new Uint8Array(wasm.memory.buffer, inputPointer, input.byteLength).set(
      input
    );
    const packed = wasm.transition(inputPointer, input.byteLength);
    const outputPointer = Number(packed >> 32n);
    const outputLength = Number(packed & 0xffffffffn);
    try {
      const output = decoder.decode(
        new Uint8Array(wasm.memory.buffer, outputPointer, outputLength)
      );
      return parseTransition(JSON.parse(output) as unknown);
    } finally {
      wasm.dealloc(outputPointer, outputLength);
    }
  } finally {
    wasm.dealloc(inputPointer, input.byteLength);
  }
}

function parseTransition(value: unknown): KernelTransition {
  if (value === null || typeof value !== "object") {
    throw new Error("Codex kernel returned a non-object transition");
  }
  const transition = value as Partial<KernelTransition>;
  if (
    transition.checkpoint === null ||
    typeof transition.checkpoint !== "object" ||
    !Array.isArray(transition.events) ||
    transition.action === null ||
    typeof transition.action !== "object" ||
    typeof transition.action.type !== "string"
  ) {
    throw new Error(
      `Codex kernel returned an invalid transition: ${JSON.stringify(value)}`
    );
  }
  // SAFETY: The outer transition shape and action discriminator were checked.
  // The Rust kernel is the sole producer and serde serializes the declared
  // KernelTransition schema. Boundary tests exercise every current variant.
  return transition as KernelTransition;
}

/** Run the static Wasm kernel directly inside the owning Durable Object. */
export class DirectKernelRuntime implements KernelRuntime {
  readonly #instance: Promise<WebAssembly.Instance>;

  constructor(module: WebAssembly.Module) {
    this.#instance = WebAssembly.instantiate(module, {});
  }

  async transition(command: KernelCommand): Promise<KernelTransition> {
    return runTransition(await this.#instance, command);
  }

  async memoryBytes(): Promise<number> {
    return exportsOf(await this.#instance).memory.buffer.byteLength;
  }
}
