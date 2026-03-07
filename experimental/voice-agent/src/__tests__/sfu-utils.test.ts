/**
 * Unit tests for SFU utility functions.
 *
 * Tests protobuf varint encoding/decoding, packet encode/decode roundtrips,
 * and audio format conversion (48kHz stereo ↔ 16kHz mono).
 */
import { describe, expect, it } from "vitest";
import {
  decodeVarint,
  encodeVarint,
  extractPayloadFromProtobuf,
  encodePayloadToProtobuf,
  downsample48kStereoTo16kMono,
  upsample16kMonoTo48kStereo
} from "../sfu-utils";

// --- Varint encoding/decoding ---

describe("varint encoding", () => {
  it("encodes single-byte values (0–127)", () => {
    expect(encodeVarint(0)).toEqual(new Uint8Array([0]));
    expect(encodeVarint(1)).toEqual(new Uint8Array([1]));
    expect(encodeVarint(127)).toEqual(new Uint8Array([127]));
  });

  it("encodes multi-byte values (>127)", () => {
    // 128 = 0x80 → [0x80, 0x01]
    expect(encodeVarint(128)).toEqual(new Uint8Array([0x80, 0x01]));
    // 300 = 0x012C → [0xAC, 0x02]
    expect(encodeVarint(300)).toEqual(new Uint8Array([0xac, 0x02]));
  });

  it("roundtrips through decode", () => {
    for (const value of [0, 1, 42, 127, 128, 255, 300, 16384, 65535]) {
      const encoded = encodeVarint(value);
      const decoded = decodeVarint(encoded, 0);
      expect(decoded.value).toBe(value);
      expect(decoded.bytesRead).toBe(encoded.length);
    }
  });

  it("decodes at arbitrary offsets", () => {
    // Prefix with 3 garbage bytes, then encode 42
    const payload = encodeVarint(42);
    const buf = new Uint8Array(3 + payload.length);
    buf[0] = 0xff;
    buf[1] = 0xff;
    buf[2] = 0xff;
    buf.set(payload, 3);

    const { value, bytesRead } = decodeVarint(buf, 3);
    expect(value).toBe(42);
    expect(bytesRead).toBe(1);
  });
});

// --- Protobuf packet encode/decode ---

describe("protobuf packet encode/decode", () => {
  it("roundtrips payload through encode → decode", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encoded = encodePayloadToProtobuf(original);
    const decoded = extractPayloadFromProtobuf(encoded);

    expect(decoded).not.toBeNull();
    expect(new Uint8Array(decoded!)).toEqual(original);
  });

  it("roundtrips empty payload", () => {
    const original = new Uint8Array([]);
    const encoded = encodePayloadToProtobuf(original);
    const decoded = extractPayloadFromProtobuf(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(0);
  });

  it("roundtrips large payload (simulating audio frame)", () => {
    // 960 samples at 48kHz stereo = 20ms frame = 3840 bytes
    const original = new Uint8Array(3840);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const encoded = encodePayloadToProtobuf(original);
    const decoded = extractPayloadFromProtobuf(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(3840);
    expect(new Uint8Array(decoded!)).toEqual(original);
  });

  it("extracts payload from a packet with other fields", () => {
    // Manually build a protobuf with:
    //   field 1 (sequenceNumber) = 42, varint
    //   field 2 (timestamp) = 1000, varint
    //   field 5 (payload) = [0xAA, 0xBB]
    const parts: Uint8Array[] = [];

    // Field 1, wire type 0: tag = (1 << 3) | 0 = 8
    parts.push(encodeVarint(8));
    parts.push(encodeVarint(42));

    // Field 2, wire type 0: tag = (2 << 3) | 0 = 16
    parts.push(encodeVarint(16));
    parts.push(encodeVarint(1000));

    // Field 5, wire type 2: tag = (5 << 3) | 2 = 42
    parts.push(encodeVarint(42));
    parts.push(encodeVarint(2)); // length = 2
    parts.push(new Uint8Array([0xaa, 0xbb]));

    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      buf.set(part, offset);
      offset += part.length;
    }

    const payload = extractPayloadFromProtobuf(buf.buffer);
    expect(payload).not.toBeNull();
    expect(new Uint8Array(payload!)).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it("returns null for empty buffer", () => {
    expect(extractPayloadFromProtobuf(new ArrayBuffer(0))).toBeNull();
  });

  it("returns null when payload field is missing", () => {
    // Only field 1 (sequenceNumber)
    const tag = encodeVarint(8); // field 1, wire type 0
    const val = encodeVarint(42);
    const buf = new Uint8Array(tag.length + val.length);
    buf.set(tag, 0);
    buf.set(val, tag.length);

    expect(extractPayloadFromProtobuf(buf.buffer)).toBeNull();
  });
});

// --- Audio conversion ---

describe("audio conversion", () => {
  /**
   * Helper: create 48kHz stereo PCM buffer with known sample values.
   * Each stereo sample pair is 4 bytes (L int16 LE + R int16 LE).
   * For downsampling, we need groups of 3 stereo pairs → 1 mono sample.
   */
  function make48kStereo(monoSamples: number[]): Uint8Array {
    // Each mono sample becomes 3 stereo pairs (for 3:1 ratio)
    const buf = new ArrayBuffer(monoSamples.length * 3 * 4);
    const view = new DataView(buf);
    for (let i = 0; i < monoSamples.length; i++) {
      const sample = monoSamples[i];
      for (let j = 0; j < 3; j++) {
        const offset = (i * 3 + j) * 4;
        view.setInt16(offset, sample, true); // left
        view.setInt16(offset + 2, sample, true); // right
      }
    }
    return new Uint8Array(buf);
  }

  /** Helper: read 16kHz mono PCM samples from ArrayBuffer. */
  function read16kMono(buf: ArrayBuffer): number[] {
    const view = new DataView(buf);
    const samples: number[] = [];
    for (let i = 0; i < buf.byteLength; i += 2) {
      samples.push(view.getInt16(i, true));
    }
    return samples;
  }

  /** Helper: create 16kHz mono PCM buffer. */
  function make16kMono(samples: number[]): ArrayBuffer {
    const buf = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(i * 2, samples[i], true);
    }
    return buf;
  }

  /** Helper: read 48kHz stereo samples as [left, right] pairs. */
  function read48kStereo(buf: Uint8Array): [number, number][] {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const pairs: [number, number][] = [];
    for (let i = 0; i < buf.byteLength; i += 4) {
      pairs.push([view.getInt16(i, true), view.getInt16(i + 2, true)]);
    }
    return pairs;
  }

  describe("downsample48kStereoTo16kMono", () => {
    it("converts identical L+R channels to mono (average = same value)", () => {
      const stereo = make48kStereo([1000, -500, 0, 32767]);
      const mono = downsample48kStereoTo16kMono(stereo);
      const samples = read16kMono(mono);

      // Each group of 3 identical stereo pairs → 1 mono sample
      // With identical L+R, average = original value
      expect(samples).toEqual([1000, -500, 0, 32767]);
    });

    it("averages left and right channels", () => {
      // Create stereo with different L and R
      const buf = new ArrayBuffer(3 * 4); // 3 stereo pairs → 1 output sample
      const view = new DataView(buf);
      // Only first pair matters for downsampling (sample at index 0*3 = 0)
      view.setInt16(0, 100, true); // left
      view.setInt16(2, 200, true); // right
      // Fill remaining pairs
      view.setInt16(4, 100, true);
      view.setInt16(6, 200, true);
      view.setInt16(8, 100, true);
      view.setInt16(10, 200, true);

      const mono = downsample48kStereoTo16kMono(new Uint8Array(buf));
      const samples = read16kMono(mono);
      expect(samples[0]).toBe(150); // (100 + 200) / 2
    });

    it("returns empty buffer for empty input", () => {
      const mono = downsample48kStereoTo16kMono(new Uint8Array(0));
      expect(mono.byteLength).toBe(0);
    });

    it("handles input shorter than one output sample", () => {
      // 2 stereo pairs (need 3 for one output sample)
      const buf = new Uint8Array(2 * 4);
      const mono = downsample48kStereoTo16kMono(buf);
      expect(mono.byteLength).toBe(0);
    });
  });

  describe("upsample16kMonoTo48kStereo", () => {
    it("duplicates mono samples to stereo pairs (3x)", () => {
      const mono = make16kMono([1000, -500]);
      const stereo = upsample16kMonoTo48kStereo(mono);
      const pairs = read48kStereo(stereo);

      // 2 mono samples → 6 stereo pairs
      expect(pairs.length).toBe(6);
      // First 3 pairs should be [1000, 1000]
      expect(pairs[0]).toEqual([1000, 1000]);
      expect(pairs[1]).toEqual([1000, 1000]);
      expect(pairs[2]).toEqual([1000, 1000]);
      // Next 3 pairs should be [-500, -500]
      expect(pairs[3]).toEqual([-500, -500]);
      expect(pairs[4]).toEqual([-500, -500]);
      expect(pairs[5]).toEqual([-500, -500]);
    });

    it("returns empty buffer for empty input", () => {
      const stereo = upsample16kMonoTo48kStereo(new ArrayBuffer(0));
      expect(stereo.length).toBe(0);
    });

    it("handles single sample", () => {
      const mono = make16kMono([42]);
      const stereo = upsample16kMonoTo48kStereo(mono);
      const pairs = read48kStereo(stereo);
      expect(pairs.length).toBe(3);
      for (const [l, r] of pairs) {
        expect(l).toBe(42);
        expect(r).toBe(42);
      }
    });
  });

  describe("downsample ↔ upsample roundtrip", () => {
    it("recovers original samples through upsample → downsample", () => {
      // Start with 16kHz mono, upsample to 48kHz stereo, downsample back
      const original = [100, -200, 300, 0, -32768, 32767];
      const mono = make16kMono(original);
      const stereo = upsample16kMonoTo48kStereo(mono);
      const roundtripped = downsample48kStereoTo16kMono(stereo);
      const result = read16kMono(roundtripped);

      expect(result).toEqual(original);
    });
  });
});
