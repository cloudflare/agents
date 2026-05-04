/**
 * Convert Float32 audio samples (-1.0..1.0) to Int16 PCM (-32768..32767).
 * Clamps values outside the -1..1 range.
 */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return int16;
}

/**
 * Compute the Root Mean Square (RMS) of audio samples.
 * Returns 0 for empty input.
 */
export function computeRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * AudioWorklet processor source code for capturing PCM from a MediaStream.
 *
 * This processor collects Float32 audio frames and posts them to the
 * main thread via the MessagePort. It runs in the AudioWorklet thread.
 *
 * Expected AudioContext sampleRate: 16000 (browser resamples from source).
 */
export const PCM_CAPTURE_PROCESSOR_SOURCE = /* js */ `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Post a copy of the Float32 channel data to the main thread
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

/**
 * AudioWorklet processor source code for playing back PCM into a MediaStream.
 *
 * Receives Float32 audio frames from the main thread via MessagePort
 * and writes them to the output buffer. Buffers frames to handle timing
 * differences between the main thread and the audio thread.
 *
 * Expected AudioContext sampleRate: 48000 (matching WebRTC).
 */
export const PCM_PLAYBACK_PROCESSOR_SOURCE = /* js */ `
class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._maxBufferFrames = 50; // ~1s at 48kHz/128 samples per frame
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this._buffer = [];
        return;
      }
      this._buffer.push(e.data);
      // Evict oldest frames if buffer grows too large
      while (this._buffer.length > this._maxBufferFrames) {
        this._buffer.shift();
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    let written = 0;

    while (written < channel.length && this._buffer.length > 0) {
      const frame = this._buffer[0];
      const available = frame.length;
      const needed = channel.length - written;

      if (available <= needed) {
        channel.set(frame, written);
        written += available;
        this._buffer.shift();
      } else {
        channel.set(frame.subarray(0, needed), written);
        this._buffer[0] = frame.subarray(needed);
        written += needed;
      }
    }

    // Fill remainder with silence
    for (let i = written; i < channel.length; i++) {
      channel[i] = 0;
    }

    return true;
  }
}
registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
`;
