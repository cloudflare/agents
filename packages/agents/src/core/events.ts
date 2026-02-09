export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  private readonly _items: Disposable[] = [];

  add<T extends Disposable>(d: T): T {
    this._items.push(d);
    return d;
  }

  dispose(): void {
    while (this._items.length) {
      try {
        this._items.pop()!.dispose();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> implements Disposable {
  private _listeners: Set<(e: T) => void> = new Set();

  readonly event: Event<T> = (listener) => {
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  };

  fire(data: T): void {
    for (const listener of [...this._listeners]) {
      try {
        listener(data);
      } catch (err) {
        // do not let one bad listener break others
        console.error("Emitter listener error:", err);
      }
    }
  }

  dispose(): void {
    this._listeners.clear();
  }
}
