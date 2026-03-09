import { describe, it, expect } from "vitest";
import {
  base64ToUint8Array,
  concatUint8Arrays,
  createWavHeader
} from "../utils/wav";

describe("server audio helpers", () => {
  // ── base64ToUint8Array ──────────────────────────────────────────────

  describe("base64ToUint8Array", () => {
    it("should decode a base64 string to Uint8Array", () => {
      // "SGVsbG8=" is base64 for "Hello"
      const result = base64ToUint8Array("SGVsbG8=");
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
      expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]); // H, e, l, l, o
    });

    it("should handle empty base64 string", () => {
      const result = base64ToUint8Array("");
      expect(result.length).toBe(0);
    });

    it("should handle base64-encoded binary data (PCM-like)", () => {
      // Create some Int16 PCM data, encode to base64, then decode
      const int16 = new Int16Array([100, -200, 32767, -32768]);
      const bytes = new Uint8Array(int16.buffer);
      const base64 = btoa(String.fromCharCode(...bytes));
      const decoded = base64ToUint8Array(base64);
      expect(decoded.length).toBe(bytes.length);
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });
  });

  // ── concatUint8Arrays ──────────────────────────────────────────────

  describe("concatUint8Arrays", () => {
    it("should concatenate multiple arrays", () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]);
      const c = new Uint8Array([6]);
      const result = concatUint8Arrays([a, b, c]);
      expect(result.length).toBe(6);
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("should return empty array for empty input", () => {
      const result = concatUint8Arrays([]);
      expect(result.length).toBe(0);
    });

    it("should handle single array", () => {
      const a = new Uint8Array([10, 20, 30]);
      const result = concatUint8Arrays([a]);
      expect(Array.from(result)).toEqual([10, 20, 30]);
    });

    it("should handle arrays with empty elements", () => {
      const a = new Uint8Array([1]);
      const b = new Uint8Array([]);
      const c = new Uint8Array([2]);
      const result = concatUint8Arrays([a, b, c]);
      expect(Array.from(result)).toEqual([1, 2]);
    });
  });

  // ── createWavHeader ────────────────────────────────────────────────

  describe("createWavHeader", () => {
    it("should create a 44-byte WAV header", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      expect(header.length).toBe(44);
    });

    it("should start with RIFF magic", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const magic = String.fromCharCode(
        header[0],
        header[1],
        header[2],
        header[3]
      );
      expect(magic).toBe("RIFF");
    });

    it("should contain WAVE format", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const format = String.fromCharCode(
        header[8],
        header[9],
        header[10],
        header[11]
      );
      expect(format).toBe("WAVE");
    });

    it("should contain fmt  chunk", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const fmt = String.fromCharCode(
        header[12],
        header[13],
        header[14],
        header[15]
      );
      expect(fmt).toBe("fmt ");
    });

    it("should contain data chunk marker", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const data = String.fromCharCode(
        header[36],
        header[37],
        header[38],
        header[39]
      );
      expect(data).toBe("data");
    });

    it("should set correct file size (36 + dataLength)", () => {
      const dataLength = 9600;
      const header = createWavHeader(dataLength, 48000, 1, 16);
      const view = new DataView(header.buffer);
      const fileSize = view.getUint32(4, true);
      expect(fileSize).toBe(36 + dataLength);
    });

    it("should set correct sample rate", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const view = new DataView(header.buffer);
      expect(view.getUint32(24, true)).toBe(48000);
    });

    it("should set correct number of channels", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const view = new DataView(header.buffer);
      expect(view.getUint16(22, true)).toBe(1);
    });

    it("should set correct bits per sample", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const view = new DataView(header.buffer);
      expect(view.getUint16(34, true)).toBe(16);
    });

    it("should set PCM format (audio format = 1)", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const view = new DataView(header.buffer);
      expect(view.getUint16(20, true)).toBe(1);
    });

    it("should set correct byte rate (sampleRate * channels * bitsPerSample/8)", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const view = new DataView(header.buffer);
      const byteRate = view.getUint32(28, true);
      expect(byteRate).toBe(48000 * 1 * (16 / 8)); // 96000
    });

    it("should set correct block align (channels * bitsPerSample/8)", () => {
      const header = createWavHeader(1000, 48000, 1, 16);
      const view = new DataView(header.buffer);
      const blockAlign = view.getUint16(32, true);
      expect(blockAlign).toBe(1 * (16 / 8)); // 2
    });

    it("should set correct data chunk size", () => {
      const dataLength = 4800;
      const header = createWavHeader(dataLength, 48000, 1, 16);
      const view = new DataView(header.buffer);
      expect(view.getUint32(40, true)).toBe(dataLength);
    });

    it("should produce a valid WAV header + PCM pipeline", () => {
      // Simulate the actual server pipeline: base64 PCM chunks → WAV file
      const pcmSamples = new Int16Array([100, -200, 300, -400, 500]);
      const pcmBytes = new Uint8Array(pcmSamples.buffer);

      const wavHeader = createWavHeader(pcmBytes.length, 48000, 1, 16);
      const wavFile = concatUint8Arrays([wavHeader, pcmBytes]);

      // Total = 44 header + 10 bytes PCM data
      expect(wavFile.length).toBe(44 + pcmBytes.length);

      // Verify the data section contains our PCM bytes
      const dataSection = wavFile.slice(44);
      expect(Array.from(dataSection)).toEqual(Array.from(pcmBytes));
    });
  });
});
