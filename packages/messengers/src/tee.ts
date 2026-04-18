/**
 * Split an AsyncIterable into N independent readers.
 *
 * Each reader gets every chunk from the source. Faster readers wait
 * for slower ones — the source is only pulled when all readers have
 * consumed the current chunk.
 *
 * Also returns a `collected` promise that resolves with the full
 * concatenated string once the source is exhausted. Useful for
 * posting the final text to platforms that do not get streamed.
 */

export function teeAsyncIterable(
  source: AsyncIterable<string>,
  count: number
): { streams: AsyncIterable<string>[]; collected: Promise<string> } {
  const buffers: string[][] = Array.from({ length: count }, () => []);
  const resolvers: Array<(() => void) | null> = Array.from(
    { length: count },
    () => null
  );
  let done = false;
  let started = false;
  let collectedResolve: (value: string) => void;
  const collected = new Promise<string>((r) => {
    collectedResolve = r;
  });

  async function pump() {
    if (started) return;
    started = true;
    let full = "";

    for await (const chunk of source) {
      full += chunk;
      for (let i = 0; i < count; i++) {
        buffers[i].push(chunk);
        resolvers[i]?.();
        resolvers[i] = null;
      }
    }

    done = true;
    for (let i = 0; i < count; i++) {
      resolvers[i]?.();
      resolvers[i] = null;
    }
    collectedResolve(full);
  }

  function createReader(index: number): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]() {
        pump();
        return {
          async next(): Promise<IteratorResult<string>> {
            while (buffers[index].length === 0) {
              if (done) return { done: true, value: undefined };
              await new Promise<void>((r) => {
                resolvers[index] = r;
              });
            }
            return { done: false, value: buffers[index].shift()! };
          }
        };
      }
    };
  }

  const streams = Array.from({ length: count }, (_, i) => createReader(i));
  return { streams, collected };
}
