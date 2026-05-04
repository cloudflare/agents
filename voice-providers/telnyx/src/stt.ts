/**
 * @cloudflare/voice-telnyx/stt
 *
 * Telnyx speech-to-text provider for the Cloudflare Agents SDK.
 * Does not depend on @telnyx/webrtc — safe to import without telephony.
 */

export {
  TelnyxSTT,
  type TelnyxSTTConfig,
  type TelnyxSTTSessionOptions
} from "./providers/stt.js";
