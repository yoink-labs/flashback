// The round's clip (reveal and results) plays muted on a loop and holds still
// while the host has paused the game.
import { useEffect, useRef } from 'react';

export function usePlayback(paused: boolean) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (paused) element.pause();
    else void element.play().catch(() => {});
  }, [paused]);
  return video;
}
