/**
 * A JSON value safe to persist across Worker and Durable Object boundaries.
 *
 * The recursive arms are interfaces rather than inline type literals so that
 * TypeScript defers resolving them. Workers RPC checks a return type with
 * `R extends Rpc.Serializable<R>`, which eagerly expands a self-referential
 * type alias and fails with "Type instantiation is excessively deep". Deferred
 * arms let a surface be returned from a Durable Object method.
 */
export type ChannelSurfaceValue =
  | null
  | boolean
  | number
  | string
  | ChannelSurfaceArray
  | ChannelSurfaceObject;

export interface ChannelSurfaceArray extends ReadonlyArray<ChannelSurfaceValue> {}

export interface ChannelSurfaceObject {
  readonly [key: string]: ChannelSurfaceValue;
}

function isSurfaceValue(value: unknown): value is ChannelSurfaceValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSurfaceValue);
  return (
    typeof value === "object" && Object.values(value).every(isSurfaceValue)
  );
}

/** A durable configured destination for one outbound message attempt. */
export type ChannelMessageSurface<
  TChannelKey extends string = string,
  TAddress extends ChannelSurfaceValue = ChannelSurfaceValue
> = Readonly<{
  channelKey: TChannelKey;
  version: 1;
  address: TAddress;
  /** Human-readable destination text captured when the surface is created. */
  label: string;
}>;

/** A Channel-produced destination before its Router stamps the configured key. */
export type ChannelMessageSurfaceInput<
  TAddress extends ChannelSurfaceValue = ChannelSurfaceValue
> = Readonly<{
  version: 1;
  address: TAddress;
  label: string;
}>;

/** Validate the common envelope before provider-specific address parsing. */
export function isChannelMessageSurface(
  value: unknown
): value is ChannelMessageSurface {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const surface = value as Record<string, unknown>;
  return (
    typeof surface.channelKey === "string" &&
    surface.channelKey.length > 0 &&
    surface.version === 1 &&
    isSurfaceValue(surface.address) &&
    typeof surface.label === "string" &&
    surface.label.trim().length > 0
  );
}
