// Service worker: offline app shell (copied from NutriSage). Built by the
// `serviceWorker` plugin in vite.config.ts into a single classic script at /sw.js, so it can import
// pure modules from src/ without becoming an ES-module worker.
/// <reference lib="webworker" />
import { routeRequest, shellCacheName, staleCaches } from "../src/swShell";

declare const self: ServiceWorkerGlobalScope;
/** Injected at build time: the build's content hash and the root paths to precache. */
declare const __SHELL_VERSION__: string;
declare const __PRECACHE__: string[];

const CACHE = shellCacheName(__SHELL_VERSION__);
/** A slow network is treated as no network after this long, so a weak signal still opens the app. */
const NAV_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  // Every asset name is content-hashed and index.html is versioned with them, so take over at once.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(__PRECACHE__.map((p) => new Request(p, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(staleCaches(keys, CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const route = routeRequest(event.request, self.location.origin, __PRECACHE__);
  if (route === "shell") event.respondWith(shell(event.request));
  else if (route === "precache") event.respondWith(precached(event.request));
  // "passthrough": no respondWith; GraphQL, Cognito and config.json always go to the network.
});

/** Network first so a new deploy shows up on the next launch; the cached index.html when offline or slow. */
async function shell(request: Request): Promise<Response> {
  const cached = () => caches.open(CACHE).then((c) => c.match("/index.html"));
  try {
    const fresh = await Promise.race([
      fetch(request),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), NAV_TIMEOUT_MS)),
    ]);
    if (fresh.ok) return fresh;
    return (await cached()) ?? fresh;
  } catch (e) {
    const hit = await cached();
    if (hit) return hit;
    throw e;
  }
}

async function precached(request: Request): Promise<Response> {
  const hit = await caches.open(CACHE).then((c) => c.match(request, { ignoreSearch: true }));
  return hit ?? fetch(request);
}

export {};
