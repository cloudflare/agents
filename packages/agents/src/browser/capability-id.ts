/**
 * The Lifecycle capability id of the `Browser` named `name`. Its own module
 * so `Agent.fetchInternalHost()` can route to a browser without importing
 * the browser code.
 */
export function browserCapabilityId(name: string): string {
  return `browser:${name}`;
}
