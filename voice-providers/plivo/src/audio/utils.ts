/**
 * Audio utilities for the Plivo telephony bridge.
 *
 * Plivo streams 8kHz G.711 mulaw; the VoiceAgent pipeline speaks 16kHz
 * 16-bit PCM. These helpers convert between the two and handle the base64
 * framing Plivo wraps each audio chunk in.
 */

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const view = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return view;
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const view = base64ToUint8Array(b64);
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

// mulaw decode table — maps each mulaw byte to a 16-bit linear PCM sample.
const MULAW_DECODE_TABLE = new Int16Array(256);
{
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function decodeMulaw(data: Uint8Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = MULAW_DECODE_TABLE[data[i]];
  }
  return out;
}

export function encodeMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (; exponent > 0; exponent--) {
    if (sample & 0x4000) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Linear-interpolating resampler between two sample rates. */
export function resamplePCM(
  input: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(a + frac * (b - a));
  }
  return output;
}

// Plivo streams 8kHz mulaw; the agent pipeline runs at 16kHz PCM.
const PLIVO_RATE = 8000;
const AGENT_RATE = 16000;

/** Decode an inbound Plivo media payload (base64 mulaw 8kHz) to 16kHz PCM. */
export function mulawBase64ToPcm16(payload: string): Int16Array {
  const mulaw = base64ToUint8Array(payload);
  return resamplePCM(decodeMulaw(mulaw), PLIVO_RATE, AGENT_RATE);
}

/** Encode 16kHz agent PCM to a base64 mulaw 8kHz payload for Plivo. */
export function pcm16ToMulawBase64(pcm: Int16Array): string {
  const pcm8k = resamplePCM(pcm, AGENT_RATE, PLIVO_RATE);
  const mulaw = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulaw[i] = encodeMulaw(pcm8k[i]);
  }
  return arrayBufferToBase64(mulaw.buffer as ArrayBuffer);
}

/** Mean squared amplitude of a PCM frame — used to detect caller speech. */
export function meanSquaredEnergy(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    sumSq += pcm[i] * pcm[i];
  }
  return sumSq / pcm.length;
}
