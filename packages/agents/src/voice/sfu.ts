/**
 * Pure utility functions for the Cloudflare Realtime SFU integration.
 *
 * Extracted from sfu.ts for testability. These handle:
 * - Protobuf varint encoding/decoding
 * - SFU WebSocket adapter protobuf packet encoding/decoding
 * - Audio format conversion (48kHz stereo ↔ 16kHz mono)
 */

// --- Protobuf helpers ---
// The SFU WebSocket adapter uses a simple protobuf message:
//   message Packet {
//     uint32 sequenceNumber = 1;
//     uint32 timestamp = 2;
//     bytes payload = 5;
//   }

export function decodeVarint(
  buf: Uint8Array,
  offset: number
): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesRead };
}

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

/** Extract the PCM payload from a protobuf Packet message. */
export function extractPayloadFromProtobuf(
  data: ArrayBuffer
): Uint8Array | null {
  const buf = new Uint8Array(data);
  let offset = 0;

  while (offset < buf.length) {
    const { value: tag, bytesRead: tagBytes } = decodeVarint(buf, offset);
    offset += tagBytes;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      // Varint
      const { bytesRead } = decodeVarint(buf, offset);
      offset += bytesRead;
    } else if (wireType === 2) {
      // Length-delimited (bytes)
      const { value: length, bytesRead: lenBytes } = decodeVarint(buf, offset);
      offset += lenBytes;

      if (fieldNumber === 5) {
        // payload field
        return buf.slice(offset, offset + length);
      }
      offset += length;
    } else {
      // Unknown wire type — skip
      break;
    }
  }

  return null;
}

/** Encode PCM payload into a protobuf Packet message (for ingest/buffer mode — just payload). */
export function encodePayloadToProtobuf(payload: Uint8Array): ArrayBuffer {
  // Field 5, wire type 2 (length-delimited): tag = (5 << 3) | 2 = 42
  const tagBytes = encodeVarint(42);
  const lengthBytes = encodeVarint(payload.length);

  const result = new Uint8Array(
    tagBytes.length + lengthBytes.length + payload.length
  );
  result.set(tagBytes, 0);
  result.set(lengthBytes, tagBytes.length);
  result.set(payload, tagBytes.length + lengthBytes.length);

  return result.buffer;
}

// --- Audio conversion ---

/** Downsample 48kHz stereo interleaved PCM to 16kHz mono PCM (both 16-bit LE). */
export function downsample48kStereoTo16kMono(
  stereo48k: Uint8Array
): ArrayBuffer {
  // Input: 48kHz stereo 16-bit LE → 2 channels × 2 bytes = 4 bytes per sample pair
  // Output: 16kHz mono 16-bit LE → 2 bytes per sample
  // Ratio: 48000/16000 = 3, plus stereo→mono = average of L+R

  const inputView = new DataView(
    stereo48k.buffer,
    stereo48k.byteOffset,
    stereo48k.byteLength
  );
  const inputSamples = stereo48k.byteLength / 4; // stereo sample pairs
  const outputSamples = Math.floor(inputSamples / 3);
  const output = new ArrayBuffer(outputSamples * 2);
  const outputView = new DataView(output);

  for (let i = 0; i < outputSamples; i++) {
    const srcOffset = i * 3 * 4; // 3x downsample, 4 bytes per stereo pair
    if (srcOffset + 3 >= stereo48k.byteLength) break;
    const left = inputView.getInt16(srcOffset, true);
    const right = inputView.getInt16(srcOffset + 2, true);
    const mono = Math.round((left + right) / 2);
    outputView.setInt16(i * 2, mono, true);
  }

  return output;
}

/** Upsample 16kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
export function upsample16kMonoTo48kStereo(mono16k: ArrayBuffer): Uint8Array {
  const inputView = new DataView(mono16k);
  const inputSamples = mono16k.byteLength / 2;
  const outputSamples = inputSamples * 3; // 3x upsample
  const output = new ArrayBuffer(outputSamples * 4); // stereo = 4 bytes per pair
  const outputView = new DataView(output);

  for (let i = 0; i < inputSamples; i++) {
    const sample = inputView.getInt16(i * 2, true);
    // Write 3 stereo samples (simple sample duplication)
    for (let j = 0; j < 3; j++) {
      const outOffset = (i * 3 + j) * 4;
      outputView.setInt16(outOffset, sample, true); // left
      outputView.setInt16(outOffset + 2, sample, true); // right
    }
  }

  return new Uint8Array(output);
}

// --- SFU API helpers ---

export interface SFUConfig {
  appId: string;
  apiToken: string;
}

const SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";

export async function sfuFetch(
  config: SFUConfig,
  path: string,
  body: unknown
): Promise<unknown> {
  const url = `${SFU_API_BASE}/apps/${config.appId}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SFU API error ${response.status}: ${text}`);
  }
  return response.json();
}

export async function createSFUSession(
  config: SFUConfig
): Promise<{ sessionId: string }> {
  const url = `${SFU_API_BASE}/apps/${config.appId}/sessions/new`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SFU API error ${response.status}: ${text}`);
  }
  return response.json() as Promise<{ sessionId: string }>;
}

export async function addSFUTracks(
  config: SFUConfig,
  sessionId: string,
  body: unknown
): Promise<unknown> {
  return sfuFetch(config, `/sessions/${sessionId}/tracks/new`, body);
}

export async function renegotiateSFUSession(
  config: SFUConfig,
  sessionId: string,
  sdp: string
): Promise<unknown> {
  const url = `${SFU_API_BASE}/apps/${config.appId}/sessions/${sessionId}/renegotiate`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sessionDescription: { type: "answer", sdp }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SFU renegotiate error ${response.status}: ${text}`);
  }
  return response.json();
}

export async function createSFUWebSocketAdapter(
  config: SFUConfig,
  tracks: unknown[]
): Promise<unknown> {
  return sfuFetch(config, "/adapters/websocket/new", { tracks });
}
