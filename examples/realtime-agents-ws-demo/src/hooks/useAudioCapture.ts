import { useRef, useState, useCallback } from "react";
import { bytesToBase64 } from "../utils/audio";

export function useAudioCapture(onChunk: (base64Audio: string) => void) {
  const [isCapturing, setIsCapturing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  const startCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      streamRef.current = stream;
      const audioContext = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(4096, 2, 2);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const s16Buffer = convertToS16LEStereo(inputData);
        const base64 = bytesToBase64(s16Buffer);
        onChunkRef.current(base64);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);

      setIsCapturing(true);
    } catch (err) {
      console.error("Failed to start audio capture:", err);
      setIsCapturing(false);
    }
  }, []);

  const stopCapture = useCallback(() => {
    // Disconnect and clean up the audio processing graph
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    // Stop the mic stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
  }, []);

  return { isCapturing, startCapture, stopCapture };
}

function convertToS16LEStereo(float32Array: Float32Array) {
  // 2 bytes per sample * 2 channels (Stereo)
  const buffer = new ArrayBuffer(float32Array.length * 2 * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32Array.length; i++) {
    // 1. Clamp and scale the mono sample
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;

    // 2. Write to Left Channel
    view.setInt16(i * 4, val, true);

    // 3. Write same value to Right Channel (Interleaved)
    view.setInt16(i * 4 + 2, val, true);
  }

  return new Uint8Array(buffer);
}
