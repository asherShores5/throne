export interface Config {
  region: string;
  userPoolId: string;
  clientId: string;
  graphqlUrl: string;
}

let config: Config | undefined;

/**
 * Runtime config, so the build has no environment baked in. Locally it's web/public/config.json
 * (gitignored; copy config.example.json and fill in the stack outputs). Once hosted, CDK writes it
 * (infra/lib/hosting.ts). The service worker never caches it, so the last good copy is kept in
 * localStorage and the installed PWA can still open offline.
 */
const CACHE_KEY = "throne.config";

export async function loadConfig(): Promise<Config> {
  if (config) return config;
  try {
    const r = await fetch("/config.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`config.json: HTTP ${r.status}`);
    config = (await r.json()) as Config;
    localStorage.setItem(CACHE_KEY, JSON.stringify(config));
  } catch (e) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) throw e;
    config = JSON.parse(cached) as Config;
  }
  return config;
}

export function getConfig(): Config {
  if (!config) throw new Error("config not loaded");
  return config;
}
