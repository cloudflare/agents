export interface ThinkVirtualModule {
  id: string;
  resolvedId: string;
  matches(id: string): boolean;
  resolve(id: string): string | null;
}

export function createVirtualModule(
  id: `virtual:think/${string}`
): ThinkVirtualModule {
  const resolvedId = `\0${id}`;
  return {
    id,
    resolvedId,
    matches(candidate) {
      return candidate === resolvedId;
    },
    resolve(candidate) {
      return candidate === id ? resolvedId : null;
    }
  };
}
