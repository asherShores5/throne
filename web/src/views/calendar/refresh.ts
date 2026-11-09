// When the Calendar reloads (spec: on app open/focus and pull-to-refresh; no live updates in v1).
import { useEffect, useRef, useState, type TouchEvent } from "react";

/** Calls `fn` when the app comes back to the front (window focus, or the page becoming visible). */
export function useRefreshOnFocus(fn: () => void) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const onFocus = () => latest.current();
    const onVisible = () => document.visibilityState === "visible" && latest.current();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/** How far (px) a pull from the top of the page has to go before letting go refreshes. */
export const PULL_PX = 70;

/**
 * Pull-to-refresh for an installed PWA (iOS gives standalone apps none): a downward drag that starts
 * with the page scrolled to the top. Spread the handlers on the area; `pull` (0..PULL_PX) drives the hint.
 */
export function usePullToRefresh(fn: () => void) {
  const start = useRef<number>(undefined);
  const [pull, setPull] = useState(0);
  const handlers = {
    onTouchStart(e: TouchEvent) {
      start.current = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : undefined;
    },
    onTouchMove(e: TouchEvent) {
      if (start.current === undefined) return;
      setPull(Math.max(0, Math.min(PULL_PX, e.touches[0].clientY - start.current)));
    },
    onTouchEnd() {
      if (start.current !== undefined && pull >= PULL_PX) fn();
      start.current = undefined;
      setPull(0);
    },
  };
  return { pull, handlers };
}
