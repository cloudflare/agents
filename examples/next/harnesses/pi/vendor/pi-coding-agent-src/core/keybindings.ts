// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream loads keybindings.json from the agent directory and subclasses
 * pi-tui's KeybindingsManager. There are no keys in a Durable Object; the types
 * survive only because ExtensionUIContext and ExtensionRunner mention them.
 */

export type { KeybindingsConfig, KeybindingsManager } from "@earendil-works/pi-tui";

/** Upstream: `keyof AppKeybindings`, a closed union of app action ids. */
export type AppKeybinding = string;
