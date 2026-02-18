/**
 * Convert a camelCase or PascalCase string to a kebab-case string.
 *
 * Consecutive uppercase letters are treated as acronyms and kept together.
 * For example, `AISessionAgent` becomes `ai-session-agent`, not `a-i-session-agent`.
 *
 * @param str The string to convert
 * @returns The kebab-case string
 *
 * @example
 * camelCaseToKebabCase("AISessionAgent")    // "ai-session-agent"
 * camelCaseToKebabCase("APIEndpoint")       // "api-endpoint"
 * camelCaseToKebabCase("MyUIComponent")     // "my-ui-component"
 * camelCaseToKebabCase("TestStateAgent")    // "test-state-agent"
 * camelCaseToKebabCase("ALLCAPS")           // "allcaps"
 */
export function camelCaseToKebabCase(str: string): string {
  // If string is all uppercase, convert to lowercase
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }

  // Handle acronyms: split before the last capital of consecutive uppercase letters
  // e.g. "AISession" → "AI-Session", "APIEndpoint" → "API-Endpoint"
  let kebabified = str.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2");
  // Split between a lowercase letter and an uppercase letter
  // e.g. "myUI" → "my-UI", "testState" → "test-State"
  kebabified = kebabified.replace(/([a-z])([A-Z])/g, "$1-$2");
  // Split between a digit and a letter or vice versa
  kebabified = kebabified.replace(/([a-zA-Z])(\d)/g, "$1-$2");
  kebabified = kebabified.replace(/(\d)([a-zA-Z])/g, "$1-$2");
  // Convert to lowercase, replace underscores with hyphens, and remove trailing hyphens
  return kebabified.toLowerCase().replace(/_/g, "-").replace(/-$/, "");
}
