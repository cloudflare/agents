let warningShown = false;

export function showExperimentalWarning(fn: string) {
  if (!warningShown) {
    warningShown = true;
    console.warn(
      `[worker-bundler] ${fn}(): This package is experimental and its API may change without notice.`
    );
  }
}
