import { useRef, useCallback, useState } from "react";
import { base64ToBytes } from "../utils/audio";

// Pipeline sends back s16le stereo PCM at this sample rate
const PLAYBACK_SAMPLE_RATE = 16000;
const PLAYBACK_CHANNELS = 1;

/**
 * Convert raw s16le (signed 16-bit little-endian) PCM bytes into a Float32Array.
 * Each Int16 sample [-32768, 32767] maps to [-1.0, 1.0].
 */
function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numSamples = Math.floor(bytes.byteLength / 2);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const s16 = view.getInt16(i * 2, true); // little-endian
    float32[i] = s16 / 32768;
  }
  return float32;
}

export function useAudioPlayback() {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const getAudioContext = useCallback((): AudioContext => {
    if (
      !audioContextRef.current ||
      audioContextRef.current.state === "closed"
    ) {
      audioContextRef.current = new AudioContext({
        sampleRate: PLAYBACK_SAMPLE_RATE
      });
      nextStartTimeRef.current = 0;
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const playAudio = useCallback(
    (base64Data: string) => {
      const ctx = getAudioContext();
      const rawBytes = base64ToBytes(base64Data);

      if (rawBytes.byteLength < 2) return; // too small to contain any samples

      const float32 = s16leToFloat32(rawBytes);
      const numFrames = Math.floor(float32.length / PLAYBACK_CHANNELS);
      if (numFrames === 0) return;

      // Create an AudioBuffer with the correct number of channels
      const audioBuffer = ctx.createBuffer(
        PLAYBACK_CHANNELS,
        numFrames,
        PLAYBACK_SAMPLE_RATE
      );

      // De-interleave stereo: [L, R, L, R, ...] → separate channel arrays
      for (let ch = 0; ch < PLAYBACK_CHANNELS; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < numFrames; i++) {
          channelData[i] = float32[i * PLAYBACK_CHANNELS + ch];
        }
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const currentTime = ctx.currentTime;
      const startTime = Math.max(currentTime, nextStartTimeRef.current);
      source.start(startTime);
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      activeSourcesRef.current.add(source);
      source.onended = () => {
        activeSourcesRef.current.delete(source);
        if (activeSourcesRef.current.size === 0) {
          setIsPlaying(false);
        }
      };
      setIsPlaying(true);
    },
    [getAudioContext]
  );

  const stopPlayback = useCallback(() => {
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // already ended
      }
    });
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsPlaying(false);
  }, []);

  return { isPlaying, playAudio, stopPlayback };
}
