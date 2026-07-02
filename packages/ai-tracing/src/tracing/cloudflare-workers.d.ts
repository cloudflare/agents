declare module "cloudflare:workers" {
  export const tracing: {
    startActiveSpan<T, Args extends readonly unknown[]>(
      name: string,
      callback: (span: Span, ...args: Args) => T,
      ...args: Args
    ): T;
  };

  export type Span = {
    readonly isTraced: boolean;
    setAttribute(
      key: string,
      value: string | number | boolean | undefined,
    ): void;
    end(): void;
  };
}
