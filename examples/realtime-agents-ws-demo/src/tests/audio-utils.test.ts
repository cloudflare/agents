import { describe, it, expect } from "vitest";
import {
  bytesToBase64,
  base64ToBytes,
  computeRMS,
  SEND_SAMPLE_RATE,
  SEND_CHANNELS,
  RECEIVE_SAMPLE_RATE,
  SILENCE_RMS_THRESHOLD
} from "../utils/audio";

describe("audio utils", () => {
  // ── Constants ────────────────────────────────────────────────────────

  describe("constants", () => {
    it("SEND_SAMPLE_RATE = 48000", () => {
      expect(SEND_SAMPLE_RATE).toBe(48000);
    });

    it("RECEIVE_SAMPLE_RATE = 16000", () => {
      expect(RECEIVE_SAMPLE_RATE).toBe(16000);
    });

    it("SEND_CHANNELS = 2 (stereo)", () => {
      expect(SEND_CHANNELS).toBe(2);
    });

    it("SILENCE_RMS_THRESHOLD = 0.01", () => {
      expect(SILENCE_RMS_THRESHOLD).toBe(0.01);
    });
  });

  // ── bytesToBase64 / base64ToBytes roundtrip ─────────────────────────

  describe("bytesToBase64 / base64ToBytes", () => {
    it("roundtrips simple bytes", () => {
      const original = new Uint8Array([0, 1, 127, 128, 255]);
      const b64 = bytesToBase64(original);
      const decoded = base64ToBytes(b64);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("produces valid base64", () => {
      const b64 = bytesToBase64(new Uint8Array([10, 20, 30]));
      expect(() => atob(b64)).not.toThrow();
    });

    it("handles empty input", () => {
      const b64 = bytesToBase64(new Uint8Array([]));
      const decoded = base64ToBytes(b64);
      expect(decoded.length).toBe(0);
    });

    it("roundtrips large arrays without stack overflow", () => {
      // 128 frames * 2 channels * 2 bytes = 512 bytes per worklet frame
      // Test with a much larger buffer
      const size = 65536;
      const original = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        original[i] = Math.floor(Math.random() * 256);
      }
      const decoded = base64ToBytes(bytesToBase64(original));
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("roundtrips Uint16 PCM data correctly", () => {
      // Simulate a stereo Uint16 buffer from the worklet
      const frameLength = 128;
      const uint16 = new Uint16Array(frameLength * SEND_CHANNELS);
      for (let i = 0; i < uint16.length; i++) {
        uint16[i] = Math.floor(Math.random() * 65536);
      }
      const bytes = new Uint8Array(uint16.buffer);
      const b64 = bytesToBase64(bytes);
      const decodedBytes = base64ToBytes(b64);

      // Reconstruct Uint16Array from decoded bytes
      const decodedUint16 = new Uint16Array(
        decodedBytes.buffer,
        decodedBytes.byteOffset,
        decodedBytes.length / 2
      );
      expect(Array.from(decodedUint16)).toEqual(Array.from(uint16));
    });
  });

  // ── computeRMS ──────────────────────────────────────────────────────

  describe("computeRMS", () => {
    it("returns 0 for silence", () => {
      expect(computeRMS(new Float32Array(128))).toBe(0);
    });

    it("returns 1 for constant 1.0 signal", () => {
      expect(computeRMS(new Float32Array(128).fill(1.0))).toBeCloseTo(1.0, 5);
    });

    it("returns 1 for alternating +1/-1 square wave", () => {
      const square = new Float32Array(128);
      for (let i = 0; i < 128; i++) square[i] = i % 2 === 0 ? 1.0 : -1.0;
      expect(computeRMS(square)).toBeCloseTo(1.0, 5);
    });

    it("detects silence below threshold", () => {
      const quiet = new Float32Array(128).fill(0.001);
      expect(computeRMS(quiet)).toBeLessThan(SILENCE_RMS_THRESHOLD);
    });

    it("detects speech above threshold", () => {
      const speech = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        speech[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / SEND_SAMPLE_RATE);
      }
      expect(computeRMS(speech)).toBeGreaterThan(SILENCE_RMS_THRESHOLD);
    });

    it("sine wave RMS ≈ amplitude / sqrt(2)", () => {
      const amplitude = 0.5;
      const length = 48000;
      const sine = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        sine[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / length);
      }
      expect(computeRMS(sine)).toBeCloseTo(amplitude / Math.sqrt(2), 2);
    });
  });

  // ── AudioWorklet output simulation ──────────────────────────────────

  describe("AudioWorklet Uint16 stereo output", () => {
    // These tests simulate what the worklet processor does,
    // verifying the format the server will receive.

    it("silence (0.0) maps to Uint16 midpoint 32768", () => {
      const s = 0.0;
      const uint16Value = Math.round((s + 1) * 0.5 * 65535);
      expect(uint16Value).toBe(32768);
    });

    it("max positive (1.0) maps to 65535", () => {
      const s = 1.0;
      expect(Math.round((s + 1) * 0.5 * 65535)).toBe(65535);
    });

    it("max negative (-1.0) maps to 0", () => {
      const s = -1.0;
      expect(Math.round((s + 1) * 0.5 * 65535)).toBe(0);
    });

    it("stereo interleaved frame has correct byte size", () => {
      const frameLength = 128; // AudioWorklet default
      const totalSamples = frameLength * SEND_CHANNELS;
      const totalBytes = totalSamples * 2; // Uint16 = 2 bytes per sample
      expect(totalBytes).toBe(512);
    });

    it("full worklet → base64 → server decode pipeline", () => {
      const frameLength = 128;

      // Simulate worklet: Float32 input → interleaved stereo Uint16
      const left = new Float32Array(frameLength);
      for (let i = 0; i < frameLength; i++) {
        left[i] = Math.sin((2 * Math.PI * 440 * i) / SEND_SAMPLE_RATE);
      }

      const uint16 = new Uint16Array(frameLength * SEND_CHANNELS);
      for (let i = 0; i < frameLength; i++) {
        const sL = Math.max(-1, Math.min(1, left[i]));
        // Mono mic → duplicate to both channels
        uint16[i * 2] = Math.round((sL + 1) * 0.5 * 65535);
        uint16[i * 2 + 1] = uint16[i * 2];
      }

      // Main thread: raw bytes → base64
      const bytes = new Uint8Array(uint16.buffer);
      const base64 = bytesToBase64(bytes);

      // Server side: base64 → bytes → Uint16Array
      const serverBytes = base64ToBytes(base64);
      expect(serverBytes.length).toBe(frameLength * SEND_CHANNELS * 2);

      const serverUint16 = new Uint16Array(
        serverBytes.buffer,
        serverBytes.byteOffset,
        serverBytes.length / 2
      );
      expect(serverUint16.length).toBe(frameLength * SEND_CHANNELS);

      // Verify L/R pairs are identical (mono duplicated)
      for (let i = 0; i < frameLength; i++) {
        expect(serverUint16[i * 2]).toBe(serverUint16[i * 2 + 1]);
      }

      // Verify no sample is 0 (silence should be 32768, not 0)
      // The sine wave has values near zero but the Uint16 midpoint is 32768
      for (let i = 0; i < serverUint16.length; i++) {
        expect(serverUint16[i]).toBeGreaterThan(0);
      }
    });

    it("silence detection filters quiet frames", () => {
      const quiet = new Float32Array(128).fill(0.001);
      expect(computeRMS(quiet)).toBeLessThan(SILENCE_RMS_THRESHOLD);

      const loud = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        loud[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SEND_SAMPLE_RATE);
      }
      expect(computeRMS(loud)).toBeGreaterThan(SILENCE_RMS_THRESHOLD);
    });
  });
});
