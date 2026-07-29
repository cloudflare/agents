/** Parameters shape shared by supported AI SDK generation and streaming operations. */
export type AISDKCallParams = Record<string, unknown> & {
  readonly model?: unknown;
  readonly tools?: unknown;
};

/**
 * Narrow callable shape consumed by the compatibility wrapper.
 *
 * AI SDK exports overloaded functions with narrower public option types for
 * each operation. The public wrapper preserves those signatures through its
 * generic T return type; this vendored contract only models the params fields
 * the wrapper reads and replaces internally.
 */
export type AISDKOperation = (
  params: AISDKCallParams,
  ...args: unknown[]
) => unknown;

export type AISDKLanguageModelMiddleware = {
  readonly wrapGenerate?: (input: {
    readonly doGenerate: () => Promise<unknown>;
    readonly params: unknown;
  }) => Promise<unknown>;
  readonly wrapStream?: (input: {
    readonly doStream: () => Promise<unknown>;
    readonly params: unknown;
  }) => Promise<unknown>;
};

/** Structural `wrapLanguageModel` function signature shared by supported majors. */
export type AISDKWrapLanguageModel = (input: {
  readonly middleware: AISDKLanguageModelMiddleware;
  readonly model: unknown;
}) => unknown;

/** Narrow AI SDK namespace fields consumed by the compatibility wrapper. */
export type AISDKNamespace = Record<string, unknown> & {
  readonly generateObject?: AISDKOperation;
  readonly generateText: AISDKOperation;
  readonly streamObject?: AISDKOperation;
  readonly streamText?: AISDKOperation;
  readonly wrapLanguageModel?: AISDKWrapLanguageModel;
};
