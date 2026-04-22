/**
 * Property keys that JavaScript runtimes and test frameworks probe
 * on arbitrary objects (serialization, thenable check, inspection,
 * matcher duck-typing). When an RPC-stub Proxy is accessed by
 * `JSON.stringify`, `console.log`, `await`, Vitest matchers, etc.,
 * it hits one of these — we must return `undefined` instead of a
 * call-wrapper to avoid firing a bogus RPC for a method the child
 * doesn't implement.
 *
 * @internal
 */
export const INTERNAL_JS_STUB_PROPS: ReadonlySet<string> = new Set([
  "toJSON",
  "then",
  "catch",
  "finally",
  "valueOf",
  "toString",
  "constructor",
  "prototype",
  "$$typeof",
  "@@toStringTag",
  "asymmetricMatch",
  "nodeType"
]);

/**
 * True when the property access is a JS-internal probe that must
 * NOT dispatch an RPC call. Catches all symbol keys plus the named
 * set above.
 *
 * @internal
 */
export function isInternalJsStubProp(prop: string | symbol): boolean {
  return typeof prop === "symbol" || INTERNAL_JS_STUB_PROPS.has(prop);
}

/**
 * Convert a camelCase string to a kebab-case string
 * @param str The string to convert
 * @returns The kebab-case string
 */
export function camelCaseToKebabCase(str: string): string {
  // If string is all uppercase, convert to lowercase
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }

  // Otherwise handle camelCase to kebab-case
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  // Convert any remaining underscores to hyphens and remove trailing -'s
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}
