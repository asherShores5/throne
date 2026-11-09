// Browser side of turning push on and off on this device, and of sign-out's push cleanup (after HoneyDo's,
// ticket 09). The pure rules are in push.ts and pushDevice.ts.
import { deletePushSubscription, putPushSubscription } from "./api/push";
import { NetworkError } from "./api/errors";
import { currentUsername } from "./auth";
import { getConfig } from "./config";
import { applicationServerKey, notificationState, subscriptionArgs, type NotificationState } from "./push";
import { SAVED_KEY, deviceId as storedDeviceId, forgetDevice, queueDelete, takeDeletes } from "./pushDevice";
import { settleWithin } from "./timeout";

/** How long to wait for a first-launch worker before calling this device unsupported. */
const WORKER_READY_MS = 3000;

const deviceId = () => storedDeviceId(localStorage);

/**
 * Push needs the worker and, on iPhone, the home-screen app (Safari tabs have no PushManager).
 * Never prompts: reading state is safe to do on load.
 */
export async function currentNotificationState(): Promise<{ state: NotificationState; reg?: ServiceWorkerRegistration }> {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  // On first launch the worker may still be installing; wait briefly before calling this unsupported.
  const reg = supported
    ? (await navigator.serviceWorker.getRegistration()) ?? (await settleWithin(navigator.serviceWorker.ready, WORKER_READY_MS))
    : undefined;
  const sub = await reg?.pushManager.getSubscription();
  const state = notificationState({
    supported: !!reg && !!getConfig().vapidPublicKey,
    permission: supported ? Notification.permission : "default",
    endpoint: sub?.endpoint,
    savedEndpoint: localStorage.getItem(SAVED_KEY) ?? undefined,
  });
  return { state, reg };
}

async function save(sub: PushSubscription) {
  await putPushSubscription(subscriptionArgs(sub.toJSON(), deviceId()));
  localStorage.setItem(SAVED_KEY, sub.endpoint);
}

/**
 * Call straight from the button's click handler with a registration fetched beforehand. iOS only shows the
 * prompt during a user gesture, so nothing (no network, no awaits) runs before requestPermission, and
 * subscribe follows it at once. Saving to the server comes last.
 */
export function enableNotifications(reg: ServiceWorkerRegistration): Promise<void> {
  return Notification.requestPermission().then(async (permission) => {
    if (permission !== "granted") throw new Error("Notifications are blocked. Turn them on in your phone's Settings, then try again.");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(getConfig().vapidPublicKey!),
    });
    await save(sub);
  });
}

/** Re-save a subscription the server doesn't have (enable finished offline, or the browser rotated it). */
export async function resaveSubscription(reg: ServiceWorkerRegistration) {
  const sub = await reg.pushManager.getSubscription();
  if (sub) await save(sub);
}

export async function disableNotifications(reg: ServiceWorkerRegistration) {
  await deletePushSubscription(deviceId());
  localStorage.removeItem(SAVED_KEY);
  await (await reg.pushManager.getSubscription())?.unsubscribe();
}

/**
 * Sign-out on this phone: delete this device's subscription, unsubscribe it, and forget its device id, so
 * the next Profile here never gets this Profile's pushes. Best effort: an offline delete is queued for this
 * Profile's next sign-in, and the unsubscribe alone makes the push service answer 410, which the Notifier
 * prunes. Call before auth.signOut, while the tokens still work.
 */
export async function releaseThisDevice() {
  const username = currentUsername();
  const id = forgetDevice(localStorage);
  if (id && username) {
    await deletePushSubscription(id).catch((e) => {
      if (e instanceof NetworkError) queueDelete(localStorage, username, id);
    });
  }
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    // Pushes already on screen name this Profile's Friends.
    for (const n of (await reg?.getNotifications()) ?? []) n.close();
  } catch {
    // nothing more to do: the record is gone or queued
  }
}

/** Send the sign-out deletes queued offline for the signed-in Profile. Call after sign-in. */
export async function sendQueuedDeletes() {
  const username = currentUsername();
  if (!username) return;
  for (const id of takeDeletes(localStorage, username)) {
    await deletePushSubscription(id).catch((e) => {
      if (e instanceof NetworkError) queueDelete(localStorage, username, id);
    });
  }
}
