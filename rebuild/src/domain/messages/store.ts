import { jsonByteLength } from "../../kernel/json.js";
import type { KeyValueStore } from "../../ports/storage.js";
import { isToolPart, type ChatMessage, type MessagePart, type ToolPart } from "./model.js";
import { sanitizeForPersistence } from "./repair.js";

const ORDER_KEY = "msg:order";
const ROW_PREFIX = "msg:row:";
const DEFAULT_MAX_ROW_BYTES = 1_800_000;
const PREVIEW_CHARS = 200;

export interface MessageStore {
  all(): ChatMessage[];
  get(id: string): ChatMessage | undefined;
  /** Upserts by id: replaces matching ids in place (stable position), appends new ones. */
  save(messages: ChatMessage[]): void;
  append(message: ChatMessage): void;
  clear(): void;
  count(): number;
}

interface TruncationMarker {
  truncated: true;
  originalBytes: number;
  preview: string;
}

/**
 * Persists the linear conversation as ordered ChatMessage rows in `store`
 * under the `msg:` prefix, with a monotonic insertion order preserved across
 * upserts. Rows whose serialized size exceeds `maxRowBytes` have their
 * largest tool outputs replaced with a truncation marker until the row fits;
 * the message itself is never dropped.
 */
export function createMessageStore(
  store: KeyValueStore,
  options?: {
    maxRowBytes?: number;
    onOversize?: (info: { messageId: string; originalBytes: number }) => void;
  }
): MessageStore {
  const maxRowBytes = options?.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES;

  function rowKey(id: string): string {
    return `${ROW_PREFIX}${id}`;
  }

  function readOrder(): string[] {
    return store.get<string[]>(ORDER_KEY) ?? [];
  }

  function upsertOne(raw: ChatMessage, order: string[], seen: Set<string>): void {
    const sanitized = sanitizeForPersistence(raw);
    const fitted = enforceRowSize(sanitized, maxRowBytes, options?.onOversize);
    store.put(rowKey(fitted.id), fitted);
    if (!seen.has(fitted.id)) {
      order.push(fitted.id);
      seen.add(fitted.id);
    }
  }

  return {
    all(): ChatMessage[] {
      const order = readOrder();
      const result: ChatMessage[] = [];
      for (const id of order) {
        const row = store.get<ChatMessage>(rowKey(id));
        if (row) result.push(row);
      }
      return result;
    },

    get(id: string): ChatMessage | undefined {
      return store.get<ChatMessage>(rowKey(id));
    },

    save(messages: ChatMessage[]): void {
      const order = readOrder();
      const seen = new Set(order);
      for (const message of messages) {
        upsertOne(message, order, seen);
      }
      store.put(ORDER_KEY, order);
    },

    append(message: ChatMessage): void {
      const order = readOrder();
      const seen = new Set(order);
      upsertOne(message, order, seen);
      store.put(ORDER_KEY, order);
    },

    clear(): void {
      store.deleteAll({ prefix: ROW_PREFIX });
      store.delete(ORDER_KEY);
    },

    count(): number {
      return readOrder().length;
    },
  };
}

function enforceRowSize(
  message: ChatMessage,
  maxRowBytes: number,
  onOversize?: (info: { messageId: string; originalBytes: number }) => void
): ChatMessage {
  const originalBytes = jsonByteLength(message);
  if (originalBytes <= maxRowBytes) return message;

  const parts = message.parts.map((part) => ({ ...part }));

  for (;;) {
    if (jsonByteLength({ ...message, parts }) <= maxRowBytes) break;

    let targetIndex = -1;
    let targetSize = -1;
    parts.forEach((part, index) => {
      if (!isToolPart(part) || part.output === undefined || isTruncationMarker(part.output)) return;
      const size = jsonByteLength(part.output);
      if (size > targetSize) {
        targetSize = size;
        targetIndex = index;
      }
    });

    if (targetIndex === -1) break; // no more compactable candidates; best effort.

    const part = parts[targetIndex] as ToolPart;
    const marker: TruncationMarker = {
      truncated: true,
      originalBytes: jsonByteLength(part.output),
      preview: makePreview(part.output),
    };
    parts[targetIndex] = { ...part, output: marker } as MessagePart;
  }

  onOversize?.({ messageId: message.id, originalBytes });
  return { ...message, parts };
}

function isTruncationMarker(value: unknown): value is TruncationMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).truncated === true &&
    "originalBytes" in (value as Record<string, unknown>) &&
    "preview" in (value as Record<string, unknown>)
  );
}

function makePreview(output: unknown): string {
  let text: string;
  try {
    text = typeof output === "string" ? output : JSON.stringify(output);
  } catch {
    text = String(output);
  }
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}
