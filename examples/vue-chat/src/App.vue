<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { AgentClient } from "agents/client";
import { WebSocketChatTransport } from "agents/chat/transport";
import { onUnmounted, ref } from "vue";

const agent = new AgentClient({
  agent: "ChatAgent",
  name: crypto.randomUUID(),
  host: window.location.host
});
const transport = new WebSocketChatTransport({
  agent,
  cancelOnClientAbort: true
});
const { error, messages, sendMessage, status, stop } = useChat({ transport });

const input = ref("");
const connected = ref(agent.readyState === WebSocket.OPEN);

agent.addEventListener("open", () => {
  connected.value = true;
});
agent.addEventListener("close", () => {
  connected.value = false;
});

async function submit() {
  const text = input.value.trim();
  if (!text || status.value === "submitted" || status.value === "streaming") {
    return;
  }

  input.value = "";
  await sendMessage({ text });
}

onUnmounted(() => agent.close());
</script>

<template>
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">Cloudflare Agents</p>
        <h1>Vue WebSocket chat</h1>
        <p class="description">
          AI SDK <code>useChat</code> connected directly to an
          <code>AIChatAgent</code> without React.
        </p>
      </div>
      <span class="connection" :class="{ connected }">
        <span class="dot" />
        {{ connected ? "Connected" : "Connecting…" }}
      </span>
    </header>

    <section class="messages" aria-live="polite">
      <p v-if="messages.length === 0" class="empty">
        Send a message to start the conversation.
      </p>

      <article
        v-for="message in messages"
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <strong>{{ message.role === "user" ? "You" : "Assistant" }}</strong>
        <template
          v-for="(part, index) in message.parts"
          :key="`${message.id}-${part.type}-${index}`"
        >
          <p v-if="part.type === 'text'" class="part">{{ part.text }}</p>
          <details v-else-if="part.type === 'reasoning'" class="part">
            <summary>Reasoning</summary>
            <p>{{ part.text }}</p>
          </details>
        </template>
      </article>
    </section>

    <p v-if="error" class="error" role="alert">{{ error.message }}</p>

    <form @submit.prevent="submit">
      <label for="prompt">Message</label>
      <div class="composer">
        <input
          id="prompt"
          v-model="input"
          autocomplete="off"
          placeholder="Ask something…"
        />
        <button
          v-if="status === 'streaming' || status === 'submitted'"
          type="button"
          class="secondary"
          @click="stop"
        >
          Stop
        </button>
        <button v-else type="submit" :disabled="!input.trim()">Send</button>
      </div>
    </form>
  </main>
</template>
