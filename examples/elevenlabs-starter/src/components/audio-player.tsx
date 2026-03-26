import { useState, useRef, useCallback } from "react";
import { Button } from "@cloudflare/kumo";
import {
  PlayIcon,
  PauseIcon,
  SpeakerHighIcon,
  SpinnerIcon
} from "@phosphor-icons/react";

export function AudioButton({
  src,
  label,
  size = "sm" as const,
  variant = "secondary"
}: {
  src: string;
  label?: string;
  size?: "sm" | "base";
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = useCallback(() => {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
      return;
    }

    const audio = new Audio(src);
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => setPlaying(false);
    audio.play();
    setPlaying(true);
  }, [src, playing]);

  return (
    <Button
      variant={variant}
      size={size}
      icon={playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
      onClick={toggle}
    >
      {label}
    </Button>
  );
}

export function SpeakButton({
  onSpeak,
  disabled
}: {
  onSpeak: () => Promise<string>;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleClick = useCallback(async () => {
    if (state === "playing" && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setState("idle");
      return;
    }

    setState("loading");
    try {
      const dataUri = await onSpeak();
      const audio = new Audio(dataUri);
      audioRef.current = audio;
      audio.onended = () => setState("idle");
      audio.onerror = () => setState("idle");
      await audio.play();
      setState("playing");
    } catch {
      setState("idle");
    }
  }, [onSpeak, state]);

  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      disabled={disabled || state === "loading"}
      icon={
        state === "loading" ? (
          <SpinnerIcon size={14} className="animate-spin" />
        ) : state === "playing" ? (
          <PauseIcon size={14} />
        ) : (
          <SpeakerHighIcon size={14} />
        )
      }
      onClick={handleClick}
      aria-label="Speak"
    />
  );
}
