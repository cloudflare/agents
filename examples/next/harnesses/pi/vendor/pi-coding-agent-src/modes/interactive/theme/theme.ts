// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream's Theme is a class that loads theme JSON from disk and emits ANSI
 * escapes. `core/extensions/runner.ts` imports the `theme` singleton as a value
 * (its no-op UI context returns it), and the extension types reference the
 * `Theme` type in renderer signatures.
 *
 * There is no terminal behind a Durable Object, so this is a plain, colourless
 * theme: every styling method returns the text unchanged and the ANSI getters
 * return empty strings.
 */

/** Upstream: closed unions of the theme's colour slots. */
export type ThemeColor = string;
export type ThemeBg = string;
export type ColorMode = "ansi" | "ansi256" | "truecolor";

export interface Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	fg(color: ThemeColor, text: string): string;
	bg(color: ThemeBg, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
	getFgAnsi(color: ThemeColor): string;
	getBgAnsi(color: ThemeBg): string;
	getColorMode(): ColorMode;
	getThinkingBorderColor(level: string): (str: string) => string;
	getBashModeBorderColor(): (str: string) => string;
}

const identity = (text: string): string => text;

export const theme: Theme = {
	name: "plain",
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: identity,
	italic: identity,
	underline: identity,
	inverse: identity,
	strikethrough: identity,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	getColorMode: () => "ansi",
	getThinkingBorderColor: () => identity,
	getBashModeBorderColor: () => identity
};
