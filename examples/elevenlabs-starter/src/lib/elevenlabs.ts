import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Buffer } from "node:buffer";

/** Create an ElevenLabs SDK client. Pass the API key from env — don't hardcode it. */
export function createClient(apiKey: string): ElevenLabsClient {
  return new ElevenLabsClient({ apiKey });
}

/** Collect a ReadableStream (from ElevenLabs TTS/SFX/Music) into a base64 data URI. */
export async function streamToDataUri(
  stream: ReadableStream,
  mimeType = "audio/mpeg"
): Promise<string> {
  const buffer = await new Response(stream).arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}
