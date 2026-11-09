// Opens the built web app (web/dist) in headless Chromium with every network call routed to
// the fake backend. Build first: npm run build:web (from the repo root). The app is served with the
// same Content-Security-Policy CloudFront sends (infra/lib/csp.ts, for these fake hosts), and any
// violation fails the run (lib.ts checklist), so a change the CSP would block shows up here.
//
//   const app = await launch();
//   const sam = await app.open("sam");                     // signed in, home screen
//   const login = await app.open("sam", { signedOut: true });
//   await app.close();
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";
import { contentSecurityPolicy } from "../infra/lib/csp";
import { cognito, graphql } from "./backend";

export const ORIGIN = "https://throne.test";
const GRAPHQL_URL = "https://e2e.appsync-api.us-west-1.amazonaws.com/graphql";
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

/** The deployed policy (hosting.ts) for the fake hosts. */
export const CSP = contentSecurityPolicy({ region: "us-west-1", graphqlHost: new URL(GRAPHQL_URL).host });

/** Content-Security-Policy violations seen by any page (lib.ts fails the checklist on any). */
export const cspViolations: string[] = [];

const CONFIG = { region: "us-west-1", userPoolId: "us-west-1_e2e", clientId: "e2e-client", graphqlUrl: GRAPHQL_URL };

/** The page's time zone (what the app sends as the device's Home zone). */
export const TIME_ZONE = "America/Los_Angeles";

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon",
};

export interface OpenOptions {
  /** Start signed out (to test the sign-in screen). */
  signedOut?: boolean;
  /** Screen: an iPhone 13 (default) or a 1280x800 desktop browser. */
  device?: "phone" | "desktop";
  /** Dark color scheme. */
  dark?: boolean;
  /**
   * A virtual platform authenticator (stands in for Face ID / Touch ID) that always passes user
   * verification. Its passkeys live in this browser context only, like a real device's.
   */
  authenticator?: boolean;
  /** Let the app's service worker run (off by default, so routes see every request). */
  serviceWorkers?: boolean;
  /** Fake the page's clock from this moment (Playwright clock: timers and Date; time keeps running). */
  clock?: Date | string;
  /** Open this path (and #hash) instead of "/", e.g. an Invite link's "/invite#<token>". */
  path?: string;
}

export async function launch() {
  if (!existsSync(path.join(DIST, "index.html"))) throw new Error("web/dist missing: run npm run build:web first");
  const browser: Browser = await chromium.launch();

  async function open(username: string, opts: OpenOptions = {}) {
    const screen = opts.device === "desktop" ? { viewport: { width: 1280, height: 800 } } : devices["iPhone 13"];
    const context = await browser.newContext({
      ...screen, serviceWorkers: opts.serviceWorkers ? "allow" : "block", timezoneId: TIME_ZONE, colorScheme: opts.dark ? "dark" : "light",
    });
    if (opts.clock) await context.clock.install({ time: opts.clock });
    const page = await context.newPage();
    if (opts.authenticator) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
    }
    page.on("pageerror", (e) => console.log(`[${username}] pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.text().startsWith("CSP violation:")) cspViolations.push(`[${username}] ${m.text()}`);
      if (m.type() === "error") console.log(`[${username}] console: ${m.text()}`);
    });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`));
    });

    if (!opts.signedOut) {
      await context.addInitScript((u) => {
        if (localStorage.getItem("throne.tokens")) return;
        localStorage.setItem("throne.tokens", JSON.stringify({
          idToken: `fake-id.${u}`, accessToken: `fake-access.${u}`, refreshToken: `fake-refresh.${u}`,
          expiresAt: Date.now() + 3600_000, username: u,
        }));
      }, username);
    }

    await context.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/config.json") return route.fulfill({ json: CONFIG });
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      if (!file.startsWith(DIST) || !existsSync(file) || url.pathname === "/") file = path.join(DIST, "index.html");
      return route.fulfill({
        body: readFileSync(file),
        contentType: TYPES[path.extname(file)] ?? "application/octet-stream",
        headers: { "content-security-policy": CSP },
      });
    });
    await context.route("https://cognito-idp.us-west-1.amazonaws.com/", async (route) => {
      const target = (route.request().headers()["x-amz-target"] ?? "").split(".").pop()!;
      const r = await cognito(target, route.request().postDataJSON());
      return route.fulfill({ status: r.status, contentType: "application/x-amz-json-1.1", body: JSON.stringify(r.json) });
    });
    await context.route(GRAPHQL_URL, async (route) => {
      const { query, variables } = route.request().postDataJSON();
      return route.fulfill({ json: await graphql(route.request().headers()["authorization"], query, variables) });
    });

    await page.goto(ORIGIN + (opts.path ?? "/"));
    return page;
  }

  return { browser, open, close: () => browser.close() };
}

export type { Page };

const offlineContexts = new WeakMap<BrowserContext, { offline: boolean }>();

/**
 * Take a page's browser context off the network (or back on). Chromium's offline mode alone still
 * lets routed requests through, so every request this context makes (the page's and its service
 * worker's) is aborted too while offline.
 */
export async function setOffline(page: Page, offline: boolean) {
  const context = page.context();
  let gate = offlineContexts.get(context);
  if (!gate) {
    const g = { offline: false };
    gate = g;
    offlineContexts.set(context, g);
    // Registered last, so it runs before the fake-backend routes and falls back to them when online.
    await context.route("**/*", (route) => (g.offline ? route.abort("internetdisconnected") : route.fallback()));
  }
  gate.offline = offline;
  await context.setOffline(offline);
}
