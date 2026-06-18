// Minimal type declaration for `tiged` (the maintained degit fork), which
// ships no types. We only use the default factory and `clone`.
declare module "tiged" {
  interface TigedOptions {
    disableCache?: boolean;
    mode?: "tar" | "git";
    force?: boolean;
    verbose?: boolean;
  }
  interface TigedEmitter {
    clone(dest: string): Promise<void>;
  }
  export default function tiged(src: string, opts?: TigedOptions): TigedEmitter;
}
