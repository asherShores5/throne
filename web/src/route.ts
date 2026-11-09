// The few screens Throne has, by URL path (CloudFront and the service worker serve index.html for any
// page path). "/" home (Log tab), "/calendar" (Calendar tab), "/friends" (Friends tab), "/settings", "/invite#<token>"; a push opens "/calendar?who=<sub>&day=<Day>" (deepLink.ts) (an Invite link; the token never leaves the browser).
import { useSyncExternalStore } from "react";

const CHANGE = "throne:navigate";

function subscribe(fn: () => void) {
  window.addEventListener("popstate", fn);
  window.addEventListener(CHANGE, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(CHANGE, fn);
  };
}

/** The current ?query (e.g. a push's Day link), re-rendering like usePath. */
export const useSearch = () => useSyncExternalStore(subscribe, () => location.search);

/** The current path, re-rendering on navigate() and the back button. */
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname);

/** Go to a path (with optional ?query), adding a history entry unless `replace`. */
export function navigate(to: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGE));
}

/** A same-page link: a real <a href> (long-press, new tab) that navigates without a reload. */
export function onLink(to: string) {
  return (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
}
