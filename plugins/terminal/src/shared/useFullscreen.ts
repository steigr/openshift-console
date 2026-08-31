import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Native Fullscreen API wrapper - console core's own `useFullscreen`
 * (@console/shared/src/hooks/useFullscreen) isn't part of the public
 * dynamic-plugin-sdk, so this is a small, self-contained equivalent.
 */
export const useFullscreen = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const canUseFullScreen = typeof document !== 'undefined' && document.fullscreenEnabled;

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      ref.current?.requestFullscreen();
    }
  }, []);

  return [ref, toggle, isFullscreen, canUseFullScreen] as const;
};
