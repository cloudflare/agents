import { useState, useCallback } from "react";
import { useAgent } from "agents/react";
import type { MusicAgent, MusicState, TrackMeta } from "../agents/music";
import {
  Button,
  InputArea,
  Surface,
  Text,
  Empty,
  Switch,
  Badge
} from "@cloudflare/kumo";
import {
  MusicNoteIcon,
  TrashIcon,
  SpinnerIcon,
  MagicWandIcon,
  ClockIcon,
  CircleIcon,
  PlayIcon
} from "@phosphor-icons/react";

const DURATION_OPTIONS = [
  { label: "15s", ms: 15000 },
  { label: "30s", ms: 30000 },
  { label: "1 min", ms: 60000 },
  { label: "2 min", ms: 120000 }
];

export function MusicTab() {
  const [connected, setConnected] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [durationMs, setDurationMs] = useState(30000);
  const [generating, setGenerating] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<TrackMeta | null>(null);
  const [currentAudio, setCurrentAudio] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);

  const agent = useAgent<MusicAgent, MusicState>({
    agent: "MusicAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const savedTracks = agent.state?.tracks ?? [];

  const generate = useCallback(async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setCurrentTrack(null);
    setCurrentAudio(null);
    try {
      const meta = (await agent.call("compose", [
        prompt,
        durationMs,
        instrumental
      ])) as TrackMeta;
      setCurrentTrack(meta);
      setLoadingAudio(true);
      const audio = (await agent.call("getTrackUrl", [meta.id])) as string;
      setCurrentAudio(audio);
    } catch (e) {
      console.error("Music generation failed:", e);
    } finally {
      setGenerating(false);
      setLoadingAudio(false);
    }
  }, [prompt, durationMs, instrumental, generating, agent]);

  const loadTrack = useCallback(
    async (meta: TrackMeta) => {
      setCurrentTrack(meta);
      setCurrentAudio(null);
      setLoadingAudio(true);
      try {
        const audio = (await agent.call("getTrackUrl", [meta.id])) as string;
        setCurrentAudio(audio);
      } catch (e) {
        console.error("Failed to load track:", e);
      } finally {
        setLoadingAudio(false);
      }
    },
    [agent]
  );

  const deleteTrack = useCallback(
    async (id: string) => {
      await agent.call("deleteTrack", [id]);
      if (currentTrack?.id === id) {
        setCurrentTrack(null);
        setCurrentAudio(null);
      }
    },
    [agent, currentTrack]
  );

  return (
    <div className="flex h-full">
      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-5 py-6 space-y-6">
          {/* Connection + compose form */}
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Text size="sm" bold>
                  Describe your music
                </Text>
                <div className="flex items-center gap-1.5">
                  <CircleIcon
                    size={8}
                    weight="fill"
                    className={
                      connected ? "text-kumo-success" : "text-kumo-danger"
                    }
                  />
                  <span className="text-xs text-kumo-subtle">
                    {connected ? "Connected" : "Disconnected"}
                  </span>
                </div>
              </div>
              <InputArea
                value={prompt}
                onValueChange={setPrompt}
                placeholder="An upbeat electronic track with a driving bassline and shimmering synths..."
                rows={3}
                disabled={generating}
                className="w-full"
              />

              {/* Options row */}
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <ClockIcon size={14} className="text-kumo-inactive" />
                  <span className="text-xs text-kumo-subtle">Duration</span>
                  <div className="flex gap-1">
                    {DURATION_OPTIONS.map((opt) => (
                      <Button
                        key={opt.ms}
                        variant={
                          durationMs === opt.ms ? "primary" : "secondary"
                        }
                        size="sm"
                        onClick={() => setDurationMs(opt.ms)}
                        disabled={generating}
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-kumo-subtle">Instrumental</span>
                  <Switch
                    checked={instrumental}
                    onCheckedChange={setInstrumental}
                    size="sm"
                  />
                </div>
              </div>

              <Button
                variant="primary"
                icon={
                  generating ? (
                    <SpinnerIcon size={16} className="animate-spin" />
                  ) : (
                    <MagicWandIcon size={16} />
                  )
                }
                disabled={!prompt.trim() || !connected || generating}
                onClick={generate}
              >
                {generating ? "Composing..." : "Compose"}
              </Button>

              {/* Presets */}
              <div className="flex flex-wrap gap-2">
                {[
                  "Upbeat electronic dance music with a catchy drop",
                  "Gentle acoustic folk with fingerpicked guitar and soft vocals",
                  "Epic cinematic orchestral score with dramatic brass and strings",
                  "Lo-fi hip hop beats to study and relax to"
                ].map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    size="sm"
                    disabled={generating}
                    onClick={() => setPrompt(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </div>
          </Surface>

          {/* Generating indicator */}
          {generating && (
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="flex items-center gap-3">
                <SpinnerIcon
                  size={16}
                  className="animate-spin text-kumo-accent"
                />
                <div>
                  <Text size="sm" variant="secondary">
                    Composing your track...
                  </Text>
                  <span className="text-xs text-kumo-subtle block mt-0.5">
                    This can take 30-60 seconds depending on duration
                  </span>
                </div>
              </div>
            </Surface>
          )}

          {/* Current track */}
          {currentTrack && (
            <Surface className="p-5 rounded-xl ring ring-kumo-line space-y-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <MusicNoteIcon size={20} className="text-kumo-accent" />
                  <div>
                    <Text size="sm" bold>
                      Generated Track
                    </Text>
                    <span className="text-xs text-kumo-subtle block mt-0.5">
                      {currentTrack.prompt}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {currentTrack.instrumental && (
                    <Badge variant="secondary">Instrumental</Badge>
                  )}
                  <Badge variant="secondary">
                    {Math.round(currentTrack.durationMs / 1000)}s
                  </Badge>
                </div>
              </div>

              {loadingAudio ? (
                <div className="flex items-center gap-2 py-2">
                  <SpinnerIcon
                    size={14}
                    className="animate-spin text-kumo-accent"
                  />
                  <span className="text-xs text-kumo-subtle">
                    Loading audio...
                  </span>
                </div>
              ) : currentAudio ? (
                /* eslint-disable-next-line jsx-a11y/media-has-caption */
                <audio
                  src={currentAudio}
                  controls
                  className="w-full rounded-lg"
                />
              ) : null}
            </Surface>
          )}

          {/* Empty state */}
          {!currentTrack && !generating && (
            <Empty
              icon={<MusicNoteIcon size={32} />}
              title="No music yet"
              contents="Describe the music you want and ElevenLabs will compose an original track. Choose a duration and whether it should be instrumental."
            />
          )}
        </div>
      </div>

      {/* Saved tracks sidebar */}
      {savedTracks.length > 0 && (
        <div className="w-72 border-l border-kumo-line bg-kumo-base overflow-y-auto p-4 space-y-3 hidden lg:block">
          <Text size="xs" bold variant="secondary">
            Library ({savedTracks.length})
          </Text>
          {savedTracks.map((track) => (
            <Surface
              key={track.id}
              className={`p-3 rounded-lg ring ring-kumo-line cursor-pointer hover:ring-kumo-accent transition-all ${
                currentTrack?.id === track.id ? "ring-kumo-brand" : ""
              }`}
              onClick={() => loadTrack(track)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm text-kumo-default line-clamp-2">
                  {track.prompt}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  aria-label="Delete track"
                  icon={<TrashIcon size={12} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteTrack(track.id);
                  }}
                />
              </div>
              <div className="flex items-center gap-2 mt-2">
                <PlayIcon size={12} className="text-kumo-inactive" />
                <div className="flex gap-1">
                  {track.instrumental && (
                    <Badge variant="secondary">Instrumental</Badge>
                  )}
                  <Badge variant="secondary">
                    {Math.round(track.durationMs / 1000)}s
                  </Badge>
                </div>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
