import type { LiveDeliveryBinding } from "./binding";
import { emailBinding } from "./bindings/email";
import { slackBinding, slackThreadBinding } from "./bindings/slack";
import { telegramBinding } from "./bindings/telegram";

/** Every destination shape must support both finished and streamed delivery. */
export const providers = [
  ["telegram", telegramBinding],
  ["slack", slackBinding],
  ["slack-thread", slackThreadBinding],
  ["email", emailBinding]
] as const satisfies readonly [string, () => LiveDeliveryBinding][];
