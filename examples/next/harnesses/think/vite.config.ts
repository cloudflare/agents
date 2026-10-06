import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  resolve: {
    // `agents` is a workspace link with its own React; one copy must serve
    // both the app and `useAgentChat`, or hooks read a null dispatcher.
    dedupe: ["react", "react-dom"]
  }
});
