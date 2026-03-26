import { useState, useCallback } from "react";
import { useAgent } from "agents/react";
import type {
  SoundscapeAgent,
  SoundscapeState,
  Scene
} from "../agents/soundscape";
import { Button, InputArea, Surface, Text, Empty } from "@cloudflare/kumo";
import {
  PlayIcon,
  PauseIcon,
  MagicWandIcon,
  FloppyDiskIcon,
  WaveformIcon,
  SpinnerIcon,
  SpeakerHighIcon,
  CircleIcon
} from "@phosphor-icons/react";
import { AudioButton } from "../components/audio-player";

type GenerationStep =
  | { stage: "idle" }
  | { stage: "expanding" }
  | {
      stage: "generating";
      narrationDone: boolean;
      effectsDone: number;
      totalEffects: number;
    }
  | { stage: "done"; scene: Scene };

export function SoundscapeTab() {
  const [connected, setConnected] = useState(false);
  const [description, setDescription] = useState("");
  const [step, setStep] = useState<GenerationStep>({ stage: "idle" });
  const [currentScene, setCurrentScene] = useState<Scene | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const [audioElements, setAudioElements] = useState<HTMLAudioElement[]>([]);

  const agent = useAgent<SoundscapeAgent, SoundscapeState>({
    agent: "SoundscapeAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const savedScenes = (agent.state?.scenes ?? []) as Scene[];

  const generate = useCallback(async () => {
    const desc = description.trim();
    if (!desc) return;

    setStep({ stage: "expanding" });
    setCurrentScene(null);

    try {
      const plan = (await agent.call("expandScene", [desc])) as {
        narration: string;
        effects: string[];
      };

      const scene: Scene = {
        id: crypto.randomUUID(),
        name: desc,
        narrationText: plan.narration,
        effects: plan.effects.map((prompt) => ({
          id: crypto.randomUUID(),
          prompt,
          audio: ""
        }))
      };

      setCurrentScene(scene);
      setStep({
        stage: "generating",
        narrationDone: false,
        effectsDone: 0,
        totalEffects: plan.effects.length
      });

      const narrationPromise = agent
        .call("generateNarration", [plan.narration])
        .then((audio) => {
          scene.narrationAudio = audio as string;
          setCurrentScene({ ...scene });
          setStep((prev) =>
            prev.stage === "generating"
              ? { ...prev, narrationDone: true }
              : prev
          );
        });

      const effectPromises = plan.effects.map((prompt, i) =>
        agent.call("generateEffect", [prompt]).then((audio) => {
          scene.effects[i] = { ...scene.effects[i], audio: audio as string };
          setCurrentScene({ ...scene });
          setStep((prev) =>
            prev.stage === "generating"
              ? { ...prev, effectsDone: prev.effectsDone + 1 }
              : prev
          );
        })
      );

      await Promise.all([narrationPromise, ...effectPromises]);
      setStep({ stage: "done", scene });
    } catch (e) {
      console.error("Generation failed:", e);
      setStep({ stage: "idle" });
    }
  }, [description, agent]);

  const playAll = useCallback(() => {
    if (!currentScene) return;
    if (playingAll) {
      audioElements.forEach((a) => {
        a.pause();
        a.currentTime = 0;
      });
      setAudioElements([]);
      setPlayingAll(false);
      return;
    }

    const elements: HTMLAudioElement[] = [];
    if (currentScene.narrationAudio) {
      const a = new Audio(currentScene.narrationAudio);
      elements.push(a);
    }
    for (const effect of currentScene.effects) {
      if (effect.audio) {
        const a = new Audio(effect.audio);
        a.volume = 0.4;
        a.loop = true;
        elements.push(a);
      }
    }

    elements.forEach((a) => a.play());
    setAudioElements(elements);
    setPlayingAll(true);

    if (elements[0]) {
      elements[0].onended = () => {
        elements.forEach((a) => {
          a.pause();
          a.currentTime = 0;
        });
        setAudioElements([]);
        setPlayingAll(false);
      };
    }
  }, [currentScene, playingAll, audioElements]);

  const saveScene = useCallback(async () => {
    if (!currentScene) return;
    await agent.call("saveScene", [currentScene]);
  }, [agent, currentScene]);

  const loadScene = useCallback((scene: Scene) => {
    setCurrentScene(scene);
    setStep({ stage: "done", scene });
    setDescription(scene.name);
  }, []);

  const isGenerating =
    step.stage === "expanding" || step.stage === "generating";

  return (
    <div className="flex h-full">
      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-5 py-6 space-y-6">
          {/* Input */}
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Text size="sm" bold>
                  Describe a scene
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
                value={description}
                onValueChange={setDescription}
                placeholder="A rainy café in Tokyo with jazz playing softly..."
                rows={2}
                disabled={isGenerating}
                className="w-full"
              />
              <Button
                variant="primary"
                icon={
                  isGenerating ? (
                    <SpinnerIcon size={16} className="animate-spin" />
                  ) : (
                    <MagicWandIcon size={16} />
                  )
                }
                disabled={!description.trim() || !connected || isGenerating}
                onClick={generate}
              >
                {isGenerating ? "Generating..." : "Generate Soundscape"}
              </Button>
              <div className="flex flex-wrap gap-2">
                {[
                  "A rainy café in Tokyo with jazz playing softly",
                  "A campfire in the woods at night with crickets and an owl",
                  "A busy spaceport with engines, announcements, and crowds",
                  "An underwater coral reef with whale songs and bubbles"
                ].map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    size="sm"
                    disabled={isGenerating}
                    onClick={() => setDescription(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </div>
          </Surface>

          {/* Progress */}
          {step.stage === "expanding" && (
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="flex items-center gap-3">
                <SpinnerIcon
                  size={16}
                  className="animate-spin text-kumo-accent"
                />
                <Text size="sm" variant="secondary">
                  AI is designing your soundscape...
                </Text>
              </div>
            </Surface>
          )}

          {step.stage === "generating" && (
            <Surface className="p-4 rounded-xl ring ring-kumo-line">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {step.narrationDone ? (
                    <CircleIcon
                      size={8}
                      weight="fill"
                      className="text-kumo-success"
                    />
                  ) : (
                    <SpinnerIcon
                      size={12}
                      className="animate-spin text-kumo-accent"
                    />
                  )}
                  <Text size="xs" variant="secondary">
                    Narration {step.narrationDone ? "ready" : "generating..."}
                  </Text>
                </div>
                <div className="flex items-center gap-2">
                  {step.effectsDone === step.totalEffects ? (
                    <CircleIcon
                      size={8}
                      weight="fill"
                      className="text-kumo-success"
                    />
                  ) : (
                    <SpinnerIcon
                      size={12}
                      className="animate-spin text-kumo-accent"
                    />
                  )}
                  <Text size="xs" variant="secondary">
                    Sound effects {step.effectsDone}/{step.totalEffects}
                  </Text>
                </div>
              </div>
            </Surface>
          )}

          {/* Scene preview */}
          {currentScene && (
            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <WaveformIcon size={18} className="text-kumo-accent" />
                  <Text size="sm" bold>
                    {currentScene.name}
                  </Text>
                </div>
                <div className="flex items-center gap-2">
                  {step.stage === "done" && (
                    <>
                      <Button
                        variant={playingAll ? "primary" : "secondary"}
                        size="sm"
                        icon={
                          playingAll ? (
                            <PauseIcon size={14} />
                          ) : (
                            <PlayIcon size={14} />
                          )
                        }
                        onClick={playAll}
                      >
                        {playingAll ? "Stop" : "Play All"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<FloppyDiskIcon size={14} />}
                        onClick={saveScene}
                      >
                        Save
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Narration */}
              <div className="space-y-2">
                <Text size="xs" bold variant="secondary">
                  Narration
                </Text>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-kumo-elevated">
                  <div className="flex-1">
                    <span className="text-sm text-kumo-default">
                      {currentScene.narrationText}
                    </span>
                  </div>
                  {currentScene.narrationAudio && (
                    <AudioButton src={currentScene.narrationAudio} size="sm" />
                  )}
                </div>
              </div>

              {/* Sound effects */}
              <div className="space-y-2">
                <Text size="xs" bold variant="secondary">
                  Ambient Layers
                </Text>
                <div className="space-y-2">
                  {currentScene.effects.map((effect) => (
                    <div
                      key={effect.id}
                      className="flex items-center gap-3 p-3 rounded-lg bg-kumo-elevated"
                    >
                      <SpeakerHighIcon
                        size={14}
                        className="text-kumo-inactive shrink-0"
                      />
                      <span className="flex-1 text-sm text-kumo-default">
                        {effect.prompt}
                      </span>
                      {effect.audio ? (
                        <AudioButton src={effect.audio} size="sm" />
                      ) : (
                        <SpinnerIcon
                          size={14}
                          className="animate-spin text-kumo-inactive"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </Surface>
          )}

          {!currentScene && step.stage === "idle" && (
            <Empty
              icon={<WaveformIcon size={32} />}
              title="No soundscape yet"
              contents="Describe a scene above and the AI will generate narration and ambient sound effects using ElevenLabs."
            />
          )}
        </div>
      </div>

      {/* Saved scenes sidebar */}
      {savedScenes.length > 0 && (
        <div className="w-64 border-l border-kumo-line bg-kumo-base overflow-y-auto p-4 space-y-3 hidden lg:block">
          <Text size="xs" bold variant="secondary">
            Saved Scenes
          </Text>
          {savedScenes.map((scene) => (
            <button
              key={scene.id}
              className="w-full text-left p-3 rounded-lg bg-kumo-elevated hover:ring hover:ring-kumo-line transition-shadow"
              onClick={() => loadScene(scene)}
            >
              <span className="text-sm font-medium text-kumo-default block truncate">
                {scene.name}
              </span>
              <span className="text-xs text-kumo-subtle mt-1 block">
                {scene.effects.length} layers
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
