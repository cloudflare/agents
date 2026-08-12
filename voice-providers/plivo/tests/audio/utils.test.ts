import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
  decodeMulaw,
  encodeMulaw,
  meanSquaredEnergy,
  mulawBase64ToPcm16,
  pcm16ToMulawBase64,
  resamplePCM
} from "../../src/audio/utils.js";

describe("base64ToArrayBuffer", () => {
  it("decodes base64 to ArrayBuffer correctly", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const b64 = btoa(String.fromCharCode(...original));
    const result = new Uint8Array(base64ToArrayBuffer(b64));
    expect(result).toEqual(original);
  });
});

describe("base64ToUint8Array", () => {
  it("decodes base64 to a Uint8Array view", () => {
    const original = new Uint8Array([255, 0, 128, 64]);
    const b64 = btoa(String.fromCharCode(...original));
    expect(base64ToUint8Array(b64)).toEqual(original);
  });
});

describe("arrayBufferToBase64", () => {
  it("encodes ArrayBuffer to base64 correctly", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const b64 = arrayBufferToBase64(original.buffer);
    expect(b64).toBe(btoa(String.fromCharCode(...original)));
  });

  it("round-trips base64 → ArrayBuffer → base64", () => {
    const original = new Uint8Array([10, 20, 30, 40]);
    const b64 = btoa(String.fromCharCode(...original));
    const roundTripped = arrayBufferToBase64(base64ToArrayBuffer(b64));
    expect(roundTripped).toBe(b64);
  });
});

describe("mulaw codec", () => {
  it("encodes silence to 0xff and decodes it back to ~0", () => {
    expect(encodeMulaw(0)).toBe(0xff);
    expect(decodeMulaw(new Uint8Array([0xff]))[0]).toBe(0);
  });

  it("preserves sign", () => {
    expect(decodeMulaw(new Uint8Array([encodeMulaw(5000)]))[0]).toBeGreaterThan(
      0
    );
    expect(decodeMulaw(new Uint8Array([encodeMulaw(-5000)]))[0]).toBeLessThan(
      0
    );
  });

  it("round-trips amplitudes within mulaw quantization error", () => {
    for (const amp of [0, 100, 1000, 5000, 10000, 20000, -8000, -15000]) {
      const decoded = decodeMulaw(new Uint8Array([encodeMulaw(amp)]))[0];
      // mulaw is logarithmic — error grows with amplitude but stays bounded.
      expect(Math.abs(decoded - amp)).toBeLessThan(Math.abs(amp) * 0.1 + 200);
    }
  });

  it("clips samples beyond the mulaw range", () => {
    const clipped = decodeMulaw(new Uint8Array([encodeMulaw(40000)]))[0];
    expect(clipped).toBeGreaterThan(30000);
    expect(clipped).toBeLessThanOrEqual(32767);
  });

  it("decodes a full buffer element-wise", () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x80]);
    expect(decodeMulaw(bytes)).toHaveLength(3);
  });
});

describe("resamplePCM", () => {
  it("returns the input unchanged when rates match", () => {
    const input = new Int16Array([1, 2, 3]);
    expect(resamplePCM(input, 8000, 8000)).toBe(input);
  });

  it("doubles length upsampling 8kHz → 16kHz", () => {
    expect(resamplePCM(new Int16Array(160), 8000, 16000)).toHaveLength(320);
  });

  it("halves length downsampling 16kHz → 8kHz", () => {
    expect(resamplePCM(new Int16Array(320), 16000, 8000)).toHaveLength(160);
  });

  it("preserves a constant signal across resampling", () => {
    const out = resamplePCM(new Int16Array(160).fill(5000), 8000, 16000);
    for (const s of out) expect(s).toBe(5000);
  });

  it("linearly interpolates between samples when upsampling", () => {
    const out = resamplePCM(new Int16Array([0, 1000]), 8000, 16000);
    // Output index 1 maps to source 0.5 → midpoint between 0 and 1000.
    expect(out[1]).toBe(500);
  });
});

describe("mulawBase64ToPcm16 / pcm16ToMulawBase64", () => {
  function pcmToMulawBase64(samples: Int16Array): string {
    const bytes = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) bytes[i] = encodeMulaw(samples[i]);
    return arrayBufferToBase64(bytes.buffer as ArrayBuffer);
  }

  it("decodes inbound mulaw 8kHz to 16kHz PCM (doubles length)", () => {
    const payload = pcmToMulawBase64(new Int16Array(160));
    expect(mulawBase64ToPcm16(payload)).toHaveLength(320);
  });

  it("encodes 16kHz PCM to mulaw 8kHz base64 (halves length)", () => {
    const payload = pcm16ToMulawBase64(new Int16Array(320).fill(8000));
    expect(base64ToArrayBuffer(payload).byteLength).toBe(160);
  });

  it("round-trips a tone through both directions within quantization error", () => {
    const payload = pcmToMulawBase64(new Int16Array(160).fill(10000));
    const pcm = mulawBase64ToPcm16(payload);
    for (const sample of pcm)
      expect(Math.abs(sample - 10000)).toBeLessThan(300);
  });
});

describe("meanSquaredEnergy", () => {
  it("is zero for silence and an empty frame", () => {
    expect(meanSquaredEnergy(new Int16Array(160))).toBe(0);
    expect(meanSquaredEnergy(new Int16Array(0))).toBe(0);
  });

  it("equals amplitude squared for a constant signal", () => {
    expect(meanSquaredEnergy(new Int16Array(160).fill(1000))).toBe(1_000_000);
  });
});
