// Audio encoding constants
export const SEND_SAMPLE_RATE = 48000;
export const RECEIVE_SAMPLE_RATE = 16000;
export const SEND_CHANNELS = 2; // Backend expects stereo (interleaved L/R)

// Silence detection: RMS below this threshold is considered silence.
// Typical mic background noise is ~0.002-0.005 RMS, speech starts at ~0.02+
export const SILENCE_RMS_THRESHOLD = 0.01;

/**
 * Convert raw bytes (ArrayBuffer / Uint8Array) to base64 string.
 * Used on the main thread to encode audio buffers from the AudioWorklet.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return btoa(parts.join(""));
}

/**
 * Decode a base64 string to raw bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compute RMS (root mean square) of a Float32 audio buffer.
 * Used for silence detection in tests; the AudioWorklet has its own inline RMS.
 */
export function computeRMS(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}
