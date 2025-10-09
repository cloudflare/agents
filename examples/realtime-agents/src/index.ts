import {
  RealtimeKitTransport,
  DeepgramSTT,
  ElevenLabsTTS
} from "agents/realtime";
import { Agent, routeAgentRequest } from "agents";

// Environment interface for required secrets and configuration
interface Env {
  // Cloudflare credentials
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;

  // Third-party API keys
  DEEPGRAM_API_KEY: string;
  ELEVENLABS_API_KEY: string;

  // RealtimeKit meeting configuration
  RTK_MEETING_ID?: string;
  RTK_AUTH_TOKEN?: string;

  // Durable Object binding
  REALTIME_VOICE_AGENT: DurableObjectNamespace;
}

export class RealtimeVoiceAgent extends Agent<Env> {
  realtimePipelineComponents = () => {
    // RealtimeKit transport for audio I/O
    const rtk = new RealtimeKitTransport(
      this.env.RTK_MEETING_ID || "default-meeting",
      this.env.RTK_AUTH_TOKEN || "default-token",
      [
        {
          media_kind: "audio",
          stream_kind: "microphone",
          preset_name: "*"
        }
      ]
    );

    // Deepgram for speech-to-text (Audio → Text)
    const stt = new DeepgramSTT(this.env.DEEPGRAM_API_KEY);

    // ElevenLabs for text-to-speech (Text → Audio)
    const tts = new ElevenLabsTTS(this.env.ELEVENLABS_API_KEY);

    return [rtk, stt, this, tts, rtk];
  };

  /**
   * Handle incoming transcribed text and generate intelligent responses
   * This is where you implement your AI logic, knowledge retrieval, etc.
   */
  async onRealtimeTranscript(
    text: string,
    reply: (text: string | ReadableStream<Uint8Array>) => void
  ): Promise<void> {
    console.log(`Received transcript: ${text}`);

    // Simple response logic - you can enhance this with:
    // - Integration with language models (OpenAI, Anthropic, etc.)
    // - Knowledge base queries
    // - Context management
    // - Intent recognition
    // - Tool calling

    let response = "";

    // Basic conversational responses
    const lowerText = text.toLowerCase().trim();

    if (lowerText.includes("hello") || lowerText.includes("hi")) {
      response = "Hello! I'm your voice assistant. How can I help you today?";
    } else if (lowerText.includes("time")) {
      const now = new Date();
      response = `The current time is ${now.toLocaleTimeString()}.`;
    } else if (lowerText.includes("date")) {
      const now = new Date();
      response = `Today's date is ${now.toLocaleDateString()}.`;
    } else if (lowerText.includes("weather")) {
      response =
        "I'd love to help with weather information, but I don't have access to weather data right now. You could integrate a weather API for real weather updates!";
    } else if (lowerText.includes("joke")) {
      const jokes = [
        "Why don't scientists trust atoms? Because they make up everything!",
        "Why did the scarecrow win an award? He was outstanding in his field!",
        "What do you call a fake noodle? An impasta!"
      ];
      response = jokes[Math.floor(Math.random() * jokes.length)];
    } else if (
      lowerText.includes("help") ||
      lowerText.includes("what can you do")
    ) {
      response =
        "I can help you with basic conversations, tell you the time and date, share jokes, and more. Try asking me about the weather or saying hello!";
    } else if (lowerText.includes("goodbye") || lowerText.includes("bye")) {
      response = "Goodbye! It was nice talking with you.";
    } else {
      // Default response for unrecognized input
      response = `You said: "${text}". I'm still learning how to respond to that. Try asking about the time, weather, or say hello!`;
    }

    // Send the response back through the pipeline
    reply(response);
  }

  /**
   * Cleanup resources when the agent is no longer needed
   */
  async cleanup(): Promise<void> {
    try {
      if (this.realtimePipelineRunning) {
        await this.stopRealtimePipeline();
        console.log("Agent stopped successfully");
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}

/**
 * Worker fetch handler - routes requests to the appropriate Durable Object
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Health check endpoint
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "healthy",
            timestamp: new Date().toISOString(),
            service: "realtime-voice-assistant"
          }),
          {
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      // Forward the request to the Durable Object
      const response = await routeAgentRequest(request, env);
      return response || new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Worker fetch error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error"
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  }
};
