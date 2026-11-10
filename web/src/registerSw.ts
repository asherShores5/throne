/// <reference types="vite/client" />

/** Production builds only: the worker (web/sw/sw.ts) only exists in dist/, and in dev it would cache Vite's modules. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return Promise.resolve(undefined);
  // updateViaCache "none": always revalidate sw.js itself, so a deploy is noticed on the next check.
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(
    (reg) => {
      // reg can be missing where workers are blocked (e.g. Playwright with serviceWorkers "block").
      // A home-screen app resumes from the background without navigating, so check for a new
      // deploy on resume too. The new worker takes over at once; the next launch loads its shell.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && navigator.onLine) void reg?.update().catch(() => {});
      });
      return reg;
    },
    (e) => {
      console.warn("service worker registration failed", e);
      return undefined;
    },
  );
}
