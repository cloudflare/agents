// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Types for `@earendil-works/pi-tui`, mapped in by the example's tsconfig
 * `paths`. pi-tui is a terminal renderer over node:tty and a native module: it
 * cannot be installed for a Worker, but the vendored extension types name a
 * handful of its types in signatures the harness never calls (setEditorComponent,
 * custom overlays, shortcuts).
 *
 * Shapes follow upstream packages/tui/src at the pinned commit, trimmed to what
 * the vendored files reference. Anything an extension actually renders in a
 * terminal is out of scope for this harness.
 */
/** Upstream: a union of every recognised key id, e.g. "ctrl+a". */
export type KeyId = string;
export type Keybinding = string;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string;
}

export interface AutocompleteProvider {
	triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean }
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export interface EditorComponent extends Component {
	getText(): string;
	setText(text: string): void;
	handleInput(data: string): void;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	addToHistory?(text: string): void;
}

export interface EditorTheme {
	[key: string]: unknown;
}

export interface OverlayOptions {
	width?: number | string;
	minWidth?: number;
	maxHeight?: number | string;
	anchor?: string;
	offsetX?: number;
	offsetY?: number;
	row?: number | string;
	col?: number | string;
	margin?: number | Record<string, number>;
	visible?: (termWidth: number, termHeight: number) => boolean;
	nonCapturing?: boolean;
}

export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(options?: { target: Component | null }): void;
	isFocused(): boolean;
}

export interface TUI extends Component {
	children: Component[];
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	requestRender(force?: boolean): void;
	renderNow(force?: boolean): void;
}

export class KeybindingsManager {
	matches(data: string, keybinding: Keybinding): boolean;
	getKeys(keybinding: Keybinding): KeyId[];
	setUserBindings(userBindings: KeybindingsConfig): void;
	getUserBindings(): KeybindingsConfig;
	getResolvedBindings(): KeybindingsConfig;
}
