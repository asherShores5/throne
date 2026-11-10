// Copied from HoneyDo (ticket 09).
// "Enable notifications": ask for permission, subscribe this device to Web Push,
// and save the subscription with putPushSubscription. Pure helpers; the browser glue is notifications.ts.

/** What the Enable step shows. "unsaved": subscribed in the browser but the server doesn't have it yet. */
export type NotificationState = "unsupported" | "blocked" | "off" | "unsaved" | "on";

export function notificationState(s: {
  supported: boolean;
  permission: NotificationPermission;
  /** This device's current browser subscription endpoint, if any. */
  endpoint?: string;
  /** The endpoint this device last saved to the server, if any. */
  savedEndpoint?: string;
}): NotificationState {
  if (!s.supported) return "unsupported";
  if (s.permission === "denied") return "blocked";
  if (s.permission !== "granted" || !s.endpoint) return "off";
  return s.endpoint === s.savedEndpoint ? "on" : "unsaved";
}

/** The VAPID public key (base64url, as in config.json) as the bytes pushManager.subscribe wants. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function subscriptionArgs(json: PushSubscriptionJSON, deviceId: string) {
  const { endpoint, keys } = json;
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("push subscription has no keys");
  return { deviceId, endpoint, p256dh: keys.p256dh, auth: keys.auth };
}
