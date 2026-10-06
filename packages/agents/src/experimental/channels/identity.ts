export type ChannelIdentity = Readonly<{
  /** Configured Channel that observed this identity. */
  channelKey: string;
  /** Stable Channel namespace in which `subject` is unique. @default "default" */
  scope?: string;
  /** Stable Channel subject within `scope`. */
  subject: string;
}>;

/** A Channel-produced identity before its Host stamps the configured key. */
export type ChannelIdentityInput = Readonly<{
  scope?: string;
  subject: string;
}>;

const DEFAULT_IDENTITY_SCOPE = "default";

type NormalizedChannelIdentity = Readonly<{
  channelKey: string;
  scope: string;
  subject: string;
}>;

function normalizeIdentity(
  identity: ChannelIdentity
): NormalizedChannelIdentity {
  return {
    channelKey: identity.channelKey,
    scope: identity.scope ?? DEFAULT_IDENTITY_SCOPE,
    subject: identity.subject
  };
}

/** Build a stable key for comparing or indexing a Channel identity. */
export function identityKey(identity: ChannelIdentity): string {
  const normalized = normalizeIdentity(identity);
  return JSON.stringify([
    normalized.channelKey,
    normalized.scope,
    normalized.subject
  ]);
}
