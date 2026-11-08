// Pure app-shell cache rules for the service worker (web/sw/sw.ts). No DOM or worker types here,
// so both the app and the worker tsconfig can include it and vitest can test it directly.

export type Route = "shell" | "precache" | "passthrough";

export interface RequestLike {
  url: string;
  method: string;
  mode: string;
}

/**
 * How the worker answers a request:
 * - "shell": a page navigation; network first, falling back to the cached index.html.
 * - "precache": a build file; cache first.
 * - "passthrough": not ours (GraphQL, Cognito, config.json, other origins); the worker doesn't touch it.
 */
export function routeRequest(req: RequestLike, origin: string, precached: readonly string[]): Route {
  if (req.method !== "GET") return "passthrough";
  const url = new URL(req.url);
  if (url.origin !== origin) return "passthrough";
  if (req.mode === "navigate") return "shell";
  return precached.includes(url.pathname) ? "precache" : "passthrough";
}

/** Never precached: the worker itself and the per-deploy config (the app keeps its own offline copy). */
const NOT_PRECACHED = new Set(["sw.js", "config.json"]);

/** Build output file names (relative to dist/) -> sorted root paths the worker precaches. */
export function precacheList(fileNames: readonly string[]): string[] {
  return fileNames
    .filter((f) => !NOT_PRECACHED.has(f) && !f.endsWith(".map"))
    .map((f) => `/${f}`)
    .sort();
}

export interface BuildFile {
  name: string;
  content: string | Uint8Array;
}

/**
 * Short content hash of the whole build (FNV-1a over sorted names and bytes). It is baked into
 * sw.js, so any deploy that changes any file changes the worker's bytes, which is what makes the
 * browser install the new worker and swap in the new shell cache.
 */
export function shellVersion(files: readonly BuildFile[]): string {
  const enc = new TextEncoder();
  let h = 0x811c9dc5;
  const feed = (bytes: Uint8Array) => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
    h = Math.imul(h ^ 0, 0x01000193); // separator, so ("ab","c") != ("a","bc")
  };
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    feed(enc.encode(f.name));
    feed(typeof f.content === "string" ? enc.encode(f.content) : f.content);
  }
  return (h >>> 0).toString(36);
}

const SHELL_PREFIX = "throne-shell-";

export const shellCacheName = (version: string) => `${SHELL_PREFIX}${version}`;

/** Shell caches from older deploys, deleted when the new worker activates. Other caches are left alone. */
export function staleCaches(keys: readonly string[], current: string): string[] {
  return keys.filter((k) => k.startsWith(SHELL_PREFIX) && k !== current);
}
