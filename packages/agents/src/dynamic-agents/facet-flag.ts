/**
 * The flag a parent stores on a facet it creates. Its own module, with no
 * imports, so `agents/chat` can read it without loading the Workers-only
 * facet runtime.
 */

/** @internal The storage key a parent sets on a facet it creates. */
export const FACET_FLAG_KEY = "cf_agents_is_facet";

/**
 * @internal Whether this Durable Object was set up as a facet, read from
 * the flag its parent stored. Readable before the Agent's own start has
 * restored its facet context.
 */
export function storedAsFacet(kv: { get(key: string): unknown }): boolean {
  return kv.get(FACET_FLAG_KEY) === true;
}
