// Push deep links (ticket 09, after HoneyDo's): what the service worker shows for a push, where a tap goes,
// and how the app reads a Day link. Pure, with no DOM or worker types, so both tsconfigs include it and
// vitest tests it directly. The glue is web/sw/sw.ts (push, notificationclick) and App.tsx (the message).
//
// Links come from shared pushLinks: "/calendar?who=<sub>&day=<Day>" (a Day; no `who` = mine), "/friends"
// (Friend requests), "/summary" (ticket 10).
// No imports: the worker build takes only plain modules from src/.
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** What the worker passes to showNotification. `data.url` is where a tap goes. */
export interface ShownNotification {
  title: string;
  options: { body: string; data: { url: string }; icon: string };
}

const ICON = "/android-chrome-192x192.png";
const FALLBACK: ShownNotification = { title: "Throne", options: { body: "Something new on Throne.", data: { url: "/" }, icon: ICON } };

/**
 * The notification for a push's text (a shared PushPayload). Never throws and always returns something to
 * show: iOS revokes the subscription of a worker that receives a push and shows nothing.
 */
export function notificationFor(raw: string | undefined): ShownNotification {
  let p: unknown;
  try {
    p = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return FALLBACK;
  }
  if (!isRecord(p) || typeof p.title !== "string" || !p.title) return FALLBACK;
  const data = isRecord(p.data) ? p.data : {};
  return {
    title: p.title,
    options: { body: typeof p.body === "string" ? p.body : "", data: { url: typeof data.url === "string" ? data.url : "/" }, icon: ICON },
  };
}

/** The message the worker posts to an open app window: "go to this screen". */
export interface NavigateMessage {
  type: "navigate";
  to: string;
}

/** An app window as notificationclick sees it (a WindowClient's url and focused). */
export interface WindowLike {
  url: string;
  focused: boolean;
}

/**
 * What a tap does: focus an open app window (the focused one first) and tell it where to go; or, with no
 * app window, open one on the link. The link always stays on the app's origin; anything else is the root.
 */
export type ClickPlan = { focus: number; message: NavigateMessage } | { open: string };

export function clickPlan(data: unknown, windows: readonly WindowLike[], origin: string): ClickPlan {
  const raw = isRecord(data) && typeof data.url === "string" ? data.url : "/";
  let target = new URL("/", origin);
  try {
    const u = new URL(raw, origin);
    if (u.origin === origin) target = u;
  } catch {
    // keep the root
  }
  const ours = windows.map((w, i) => ({ w, i })).filter(({ w }) => sameOrigin(w.url, origin));
  const pick = ours.find(({ w }) => w.focused) ?? ours[0];
  if (!pick) return { open: target.href };
  return { focus: pick.i, message: { type: "navigate", to: target.pathname + target.search } };
}

/** The path an incoming worker message asks the app to go to, if it is a NavigateMessage for this app. */
export function navigateMessage(data: unknown): string | undefined {
  if (!isRecord(data) || data.type !== "navigate" || typeof data.to !== "string") return undefined;
  return data.to.startsWith("/") && !data.to.startsWith("//") ? data.to : undefined;
}

/** A Day link's parts (`location.search` of /calendar): whose Calendar (none = mine) and which Day. */
export function calendarLink(search: string): { who?: string; day?: string } {
  const q = new URLSearchParams(search);
  const day = q.get("day") ?? undefined;
  return { who: q.get("who") || undefined, day: day && isDay(day) ? day : undefined };
}

function sameOrigin(href: string, origin: string): boolean {
  try {
    return new URL(href).origin === origin;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
