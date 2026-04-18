/**
 * Verify Telegram webhook requests.
 *
 * Telegram supports a secret_token parameter when setting webhooks.
 * When set, Telegram sends it in the X-Telegram-Bot-Api-Secret-Token
 * header. We validate against that.
 *
 * If no secret token was configured, verification is skipped (returns true).
 */

import { timingSafeEqual } from "../../timing-safe-equal";

export function verifyTelegramRequest(
  request: Request,
  secretToken: string | undefined
): boolean {
  if (!secretToken) {
    return true;
  }

  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!header) {
    return false;
  }

  return timingSafeEqual(header, secretToken);
}
