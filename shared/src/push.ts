// Push notifications (ticket 09): preferences, the Web Push subscription rules (copied from HoneyDo),
// the events the API hands the Notifier, and the text a push carries. Pure, shared by api and web.
//
// Push text never carries Details (Duration, Bristol type, Note, Flags), Comment text or Reaction emoji:
// it names who did what ("Sam logged"), built from an allowlist rather than by copying a record.

/** The on/off pushes a Profile picks once (Friend logged is picked per Friend, on the Friendship). */
export interface PushToggles {
  /** The weekly Summary (ticket 10). On by default. */
  summary: boolean;
  /** A Friend request arrives, or one I sent is accepted. */
  friendRequests: boolean;
  /** A Friend reacts to or comments on one of my Logs. */
  reactionsComments: boolean;
}

/** Everything the Settings screen shows: the toggles plus the Friends whose Logs push to me. */
export interface PushPrefs extends PushToggles {
  /** Profile ids of the Friends I follow ("Friend logged"); empty by default. */
  friendLogged: string[];
}

export const DEFAULT_PUSH_PREFS: Readonly<PushToggles> = Object.freeze({ summary: true, friendRequests: false, reactionsComments: false });

const TOGGLES = ["summary", "friendRequests", "reactionsComments"] as const;

/** Stored toggles (a Profile from before ticket 09 has none): each one that isn't a boolean takes its default. */
export function readPushPrefs(raw: unknown): PushToggles {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_PUSH_PREFS };
  for (const k of TOGGLES) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  return out;
}

/** At most this many Friends, so a longer list is junk. */
const FRIEND_LIST_MAX = 3;

export type PushPrefsEdit =
  | { ok: true; toggles: Partial<PushToggles>; friendLogged: string[] | undefined }
  | { ok: false; error: string };

/** An updatePushPrefs input: only the toggles sent change; `friendLogged`, if sent, is the whole list. */
export function parsePushPrefsInput(input: unknown): PushPrefsEdit {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const toggles: Partial<PushToggles> = {};
  for (const k of TOGGLES) {
    if (i[k] == null) continue;
    if (typeof i[k] !== "boolean") return { ok: false, error: `${k} is true or false.` };
    toggles[k] = i[k] as boolean;
  }
  let friendLogged: string[] | undefined;
  if (i.friendLogged != null) {
    const l = i.friendLogged;
    if (!Array.isArray(l) || l.length > FRIEND_LIST_MAX || !l.every((x) => typeof x === "string" && x.length > 0 && x.length <= 128)) {
      return { ok: false, error: "friendLogged is a list of your Friends." };
    }
    friendLogged = [...new Set(l as string[])];
  }
  return { ok: true, toggles, friendLogged };
}

// ---- subscriptions ----------------------------------------------------------

/** Devices per Profile that can get pushes. A lost phone frees its place after its next failed push. */
export const PUSH_DEVICES_MAX = 10;

export interface PushSubscriptionInput {
  /** A random UUID the device keeps, so re-enabling replaces its own record. */
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export const isDeviceId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** The browsers' push services: Chrome/Android, Firefox, Safari/iOS, Edge on Windows. */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

/**
 * The Notifier POSTs to the endpoint, so it must be a known push service over https on 443, or anyone
 * signed in could aim the Lambda at any host (SSRF). URL lowercases the host and drops ":443"; IP
 * literals and trailing-dot hosts never match the list.
 */
function isPushServiceUrl(url: URL | undefined): boolean {
  if (!url || url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname;
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length && !host.startsWith("."));
}

/** A browser PushSubscription as the Enable step sends it; throws an Error with a plain message if it isn't one. */
export function parsePushSubscription(input: unknown): PushSubscriptionInput {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (!isDeviceId(i.deviceId)) throw new Error("bad device id");
  const endpoint = i.endpoint;
  let url: URL | undefined;
  try {
    url = typeof endpoint === "string" ? new URL(endpoint) : undefined;
  } catch {
    // falls through to the check below
  }
  if (typeof endpoint !== "string" || endpoint.length > 2048 || !isPushServiceUrl(url)) throw new Error("bad push endpoint");
  for (const [k, max] of [[i.p256dh, 200], [i.auth, 100]] as const) {
    if (typeof k !== "string" || !B64URL_RE.test(k) || k.length > max) throw new Error("bad push key");
  }
  return { deviceId: i.deviceId.toLowerCase(), endpoint, p256dh: i.p256dh as string, auth: i.auth as string };
}

// ---- events -----------------------------------------------------------------

/**
 * What the API hands the Notifier after a write commits (an async Lambda invoke): ids only, never Details.
 * `to` is who gets the push; for friendLogged the Notifier finds the Friends who follow `from`.
 */
export type PushEvent =
  | { kind: "friendRequest" | "friendAccepted"; to: string; from: string }
  | { kind: "reaction" | "comment"; to: string; from: string; logId: string; day: string }
  | { kind: "friendLogged"; from: string; logId: string; day: string };

export type PushKind = PushEvent["kind"] | "summary";

/** What the hourly schedule (infra/lib/stacks.ts) invokes the Notifier with: the weekly Summary run. */
export const SCHEDULED_RUN = Object.freeze({ run: "summary" });

/** True for the hourly schedule's event (anything else that isn't a PushEvent is ignored). */
export const isScheduledRun = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { run?: unknown }).run === SCHEDULED_RUN.run;

/** Where a tap goes (web/src/deepLink.ts opens it). */
export const pushLinks = {
  /** A Day on the Calendar: mine, or a Friend's (`who`). */
  day: (day: string, who?: string) => `/calendar?${who ? `who=${encodeURIComponent(who)}&` : ""}day=${encodeURIComponent(day)}`,
  friends: "/friends",
  /** The Summary screen (ticket 10). */
  summary: "/summary",
} as const;

const HOUR = 3600;

/** Everything that differs between push kinds, in one place (the Notifier and the payload builders read it). */
export interface PushKindRule {
  /** The toggle that lets it through; undefined = picked per Friend instead ("Friend logged"). */
  toggle?: keyof PushToggles;
  /** Seconds the push service keeps it undelivered (RFC 8030 §5.2). */
  ttl: number;
  /**
   * A newer push with the same topic replaces an undelivered one (RFC 8030 §5.4): "sender" = one per Friend who
   * did it, "fixed" = one for the kind; undefined = each stands alone.
   */
  topic?: "sender" | "fixed";
  /**
   * What the Notifier re-checks before sending (it may run after the fact changed): the Friend request still
   * waiting, the Friendship still there, or who follows the sender now; "none" for the scheduled Summary.
   */
  recheck: "request" | "friendship" | "followers" | "none";
  /** The event's fields besides `kind`: to + from ("pair"), plus the Log ("log"), or from + the Log ("followed"). */
  shape?: "pair" | "log" | "followed";
  /** Push text from the doer's Display name (nothing else goes in). */
  body: (name: string) => string;
}

export const PUSH_KINDS: Readonly<Record<PushKind, Readonly<PushKindRule>>> = Object.freeze({
  // A Friend request or Reaction still matters tomorrow; a "Friend logged" is stale after a few hours.
  friendRequest: { toggle: "friendRequests", ttl: 24 * HOUR, recheck: "request", shape: "pair", body: (n: string) => `${n} sent you a Friend request` },
  friendAccepted: { toggle: "friendRequests", ttl: 24 * HOUR, recheck: "friendship", shape: "pair", body: (n: string) => `${n} accepted your Friend request` },
  reaction: { toggle: "reactionsComments", ttl: 24 * HOUR, recheck: "friendship", shape: "log", body: (n: string) => `${n} reacted to your Log` },
  comment: { toggle: "reactionsComments", ttl: 24 * HOUR, recheck: "friendship", shape: "log", body: (n: string) => `${n} commented on your Log` },
  friendLogged: { ttl: 6 * HOUR, topic: "sender", recheck: "followers", shape: "followed", body: (n: string) => `${n} logged` },
  // No counts or names (it can show on a lock screen). A newer one replaces an older (a phone off all week).
  summary: { toggle: "summary", ttl: 24 * HOUR, topic: "fixed", recheck: "none", body: () => "Last week's Summary is ready" },
} satisfies Record<PushKind, PushKindRule>);

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const isDayString = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A PushEvent rebuilt field by field from whatever arrived; undefined if it isn't one. */
export function parsePushEvent(e: unknown): PushEvent | undefined {
  if (!e || typeof e !== "object") return undefined;
  const r = e as Record<string, unknown>;
  const kind = r.kind as PushKind;
  const shape = typeof kind === "string" && Object.hasOwn(PUSH_KINDS, kind) ? PUSH_KINDS[kind].shape : undefined;
  if (!shape || !isId(r.from)) return undefined;
  if (shape === "pair") return isId(r.to) ? ({ kind, to: r.to, from: r.from } as PushEvent) : undefined;
  if (!isId(r.logId) || !isDayString(r.day)) return undefined;
  if (shape === "followed") return { kind, from: r.from, logId: r.logId, day: r.day } as PushEvent;
  return isId(r.to) ? ({ kind, to: r.to, from: r.from, logId: r.logId, day: r.day } as PushEvent) : undefined;
}

// ---- payloads ---------------------------------------------------------------

/** What a push carries, as the service worker reads it: `showNotification(title, { body, data })`. */
export interface PushPayload {
  title: string;
  body: string;
  data: { kind: PushKind; url: string };
}

const TITLE = "Throne";

/** Where an event's push opens: the Log's Day (on the Friend's Calendar for friendLogged) or the Friends tab. */
function eventLink(e: PushEvent): string {
  if (e.kind === "friendLogged") return pushLinks.day(e.day, e.from);
  return "day" in e ? pushLinks.day(e.day) : pushLinks.friends;
}

/** The push for one event, given the Display name of who did it. Only the name and the kind go in. */
export function eventPushPayload(e: PushEvent, fromName: string): PushPayload {
  return { title: TITLE, body: PUSH_KINDS[e.kind].body(fromName), data: { kind: e.kind, url: eventLink(e) } };
}

/** The weekly Summary push: no counts or names (it can show on a lock screen), just a way in. */
export function summaryPushPayload(): PushPayload {
  return { title: TITLE, body: PUSH_KINDS.summary.body(""), data: { kind: "summary", url: pushLinks.summary } };
}
