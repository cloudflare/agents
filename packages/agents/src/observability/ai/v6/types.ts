/** Parameters shape shared by AI SDK v6 generation and streaming operations. */
export type AISDKV6CallParams = Record<string, unknown> & {
  readonly model?: unknown;
  readonly tools?: unknown;
};

/**
 * Narrow callable shape consumed by the v6 adapter.
 *
 * AI SDK exports overloaded functions with narrower public option types for
 * each operation. The public wrapper preserves those signatures through its
 * generic T return type; this vendored contract only models the params fields
 * the adapter reads and replaces internally.
 */
export type AISDKV6Operation = (
  params: AISDKV6CallParams,
  ...args: unknown[]
) => unknown;

export type AISDKV6LanguageModelMiddleware = {
  readonly wrapGenerate?: (input: {
    readonly doGenerate: () => Promise<unknown>;
    readonly params: unknown;
  }) => Promise<unknown>;
  readonly wrapStream?: (input: {
    readonly doStream: () => Promise<unknown>;
    readonly params: unknown;
  }) => Promise<unknown>;
};

/** AI SDK v6 `wrapLanguageModel` function signature. */
export type AISDKV6WrapLanguageModel = (input: {
  readonly middleware: AISDKV6LanguageModelMiddleware;
  readonly model: unknown;
}) => unknown;

/** Narrow AI SDK v6 namespace fields consumed by the v6 adapter. */
export type AISDKV6Namespace = Record<string, unknown> & {
  readonly generateObject?: AISDKV6Operation;
  readonly generateText: AISDKV6Operation;
  readonly streamObject?: AISDKV6Operation;
  readonly streamText?: AISDKV6Operation;
  readonly wrapLanguageModel?: AISDKV6WrapLanguageModel;
};
