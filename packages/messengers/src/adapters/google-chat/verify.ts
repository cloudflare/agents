/**
 * Verify Google Chat webhook requests using the static verification
 * token from the Chat API console.
 *
 * Google Chat also supports JWT verification (RS256 from
 * chat@system.gserviceaccount.com) but that requires X.509
 * certificate parsing which is complex in Workers. The static
 * token approach is simpler and sufficient for most use cases.
 */

import { timingSafeEqual } from "../../timing-safe-equal";

export function verifyGoogleChatToken(
  payload: Record<string, unknown>,
  expectedToken: string
): boolean {
  const token = payload.token as string | undefined;
  if (!token) return false;
  return timingSafeEqual(token, expectedToken);
}
