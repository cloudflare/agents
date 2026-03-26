import { Suspense, useState, useCallback } from "react";
import { Button, Surface, Text, Tabs } from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { CloudflareLogo } from "@cloudflare/kumo";
import {
  SunIcon,
  MoonIcon,
  ChatCircleDotsIcon,
  WaveformIcon,
  UserCircleIcon,
  MusicNoteIcon,
  InfoIcon
} from "@phosphor-icons/react";

import { VoiceChatTab } from "./tabs/voice-chat";
import { SoundscapeTab } from "./tabs/soundscape";
import { CharacterTab } from "./tabs/character";
import { MusicTab } from "./tabs/music";

type TabId = "voice-chat" | "soundscape" | "character" | "music";

function ElevenLabsLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="ElevenLabs logo"
    >
      <rect
        x="11"
        y="4"
        width="3.5"
        height="24"
        rx="1.75"
        fill="currentColor"
      />
      <rect
        x="17.5"
        y="4"
        width="3.5"
        height="24"
        rx="1.75"
        fill="currentColor"
      />
    </svg>
  );
}

function ModeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

export default function App() {
  const [tab, setTab] = useState<TabId>("voice-chat");

  return (
    <Toasty>
      <div className="flex flex-col h-screen bg-kumo-elevated">
        {/* Header */}
        <header className="px-5 pt-4 pb-0 bg-kumo-base border-b border-kumo-line">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <ElevenLabsLogo className="w-6 h-6 text-kumo-default" />
                <span className="text-base font-semibold text-kumo-default">
                  ElevenLabs
                </span>
                <span className="text-kumo-inactive text-lg font-light mx-1">
                  ×
                </span>
                <CloudflareLogo variant="glyph" color="color" className="h-4" />
                <span className="text-base font-semibold text-kumo-default">
                  Cloudflare
                </span>
              </div>
              <ModeToggle />
            </div>

            <Tabs
              variant="segmented"
              value={tab}
              onValueChange={(v) => setTab(v as TabId)}
              tabs={[
                {
                  value: "voice-chat",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <ChatCircleDotsIcon size={14} /> Voice Chat
                    </span>
                  )
                },
                {
                  value: "soundscape",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <WaveformIcon size={14} /> Soundscape
                    </span>
                  )
                },
                {
                  value: "character",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <UserCircleIcon size={14} /> Character
                    </span>
                  )
                },
                {
                  value: "music",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <MusicNoteIcon size={14} /> Music
                    </span>
                  )
                }
              ]}
            />
          </div>
        </header>

        {/* Explainer */}
        <div className="px-5 pt-4 bg-kumo-elevated">
          <div className="max-w-4xl mx-auto">
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="flex gap-3">
                <InfoIcon
                  size={20}
                  weight="bold"
                  className="text-kumo-accent shrink-0 mt-0.5"
                />
                <div>
                  <Text size="sm" bold>
                    {tab === "voice-chat" && "Voice Chat"}
                    {tab === "soundscape" && "Soundscape Builder"}
                    {tab === "character" && "Character Creator"}
                    {tab === "music" && "Music Studio"}
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      {tab === "voice-chat" &&
                        "Chat with an AI agent powered by Workers AI. Every response is automatically spoken aloud via ElevenLabs TTS. Tap the mic to speak — your audio streams to ElevenLabs Realtime STT with live transcription."}
                      {tab === "soundscape" &&
                        "Describe a scene and the AI generates narration (ElevenLabs TTS) plus ambient sound effects (ElevenLabs Sound Effects API). Mix and play them together."}
                      {tab === "character" &&
                        "Design a custom AI character — describe a personality and a voice. ElevenLabs Voice Design creates a unique voice, then chat with your character and hear every response spoken."}
                      {tab === "music" &&
                        "Compose original music from a text prompt using ElevenLabs Music API. Choose a duration, toggle instrumental mode, and build a library of generated tracks."}
                    </Text>
                  </span>
                </div>
              </div>
            </Surface>
          </div>
        </div>

        {/* Tab content */}
        <main className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-kumo-inactive">
                Loading...
              </div>
            }
          >
            {tab === "voice-chat" && <VoiceChatTab />}
            {tab === "soundscape" && <SoundscapeTab />}
            {tab === "character" && <CharacterTab />}
            {tab === "music" && <MusicTab />}
          </Suspense>
        </main>
      </div>
    </Toasty>
  );
}
