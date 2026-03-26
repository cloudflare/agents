import { Agent, callable } from "agents";
import { createClient } from "../lib/elevenlabs";

export interface TrackMeta {
  id: string;
  prompt: string;
  instrumental: boolean;
  durationMs: number;
  createdAt: string;
}

export interface MusicState {
  tracks: TrackMeta[]; // metadata only — audio lives in R2
}

/**
 * Music Studio agent — compose tracks via ElevenLabs Music API.
 * Audio is stored in R2 (not agent state) to avoid bloating WebSocket sync.
 */
export class MusicAgent extends Agent<Env, MusicState> {
  initialState: MusicState = { tracks: [] };

  /** Compose a track, store audio in R2, return metadata. */
  @callable()
  async compose(
    prompt: string,
    durationMs: number,
    instrumental: boolean
  ): Promise<TrackMeta> {
    const client = createClient(this.env.ELEVENLABS_API_KEY);
    const audioStream = await client.music.compose({
      prompt,
      musicLengthMs: Math.max(3000, Math.min(600000, durationMs)),
      forceInstrumental: instrumental,
      outputFormat: "mp3_44100_128"
    });

    const id = crypto.randomUUID();
    const audioBuffer = await new Response(audioStream).arrayBuffer();

    await this.env.AUDIO_BUCKET.put(`music/${id}.mp3`, audioBuffer, {
      httpMetadata: { contentType: "audio/mpeg" }
    });

    const meta: TrackMeta = {
      id,
      prompt,
      instrumental,
      durationMs,
      createdAt: new Date().toISOString()
    };

    this.setState({
      ...this.state,
      tracks: [meta, ...this.state.tracks]
    });

    return meta;
  }

  /** Fetch audio from R2 and return as a data URI for browser playback. */
  @callable()
  async getTrackUrl(id: string): Promise<string> {
    const object = await this.env.AUDIO_BUCKET.get(`music/${id}.mp3`);
    if (!object) throw new Error("Track not found");

    const { Buffer } = await import("node:buffer");
    const buffer = await object.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:audio/mpeg;base64,${base64}`;
  }

  /** Delete a track from both R2 and agent state. */
  @callable()
  async deleteTrack(id: string) {
    await this.env.AUDIO_BUCKET.delete(`music/${id}.mp3`);
    this.setState({
      ...this.state,
      tracks: this.state.tracks.filter((t) => t.id !== id)
    });
  }
}
