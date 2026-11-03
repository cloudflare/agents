/**
 * The outcome of a skills operation that can fail in an expected way.
 *
 * Skill parsing and source I/O return failures as values instead of throwing,
 * so a broken `SKILL.md` or an unreachable bucket never takes down the agent.
 *
 * @template T - The success value.
 * @template E - The expected error.
 */
export type SkillResult<T, E extends Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** @internal Wrap a success value. */
export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/** @internal Wrap an expected error. */
export function err<E extends Error>(
  error: E
): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
