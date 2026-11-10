// Copied from HoneyDo (ticket 09).
// This device's push identity in localStorage, and what sign-out does with it.
// Pure over a key-value store, so it is tested without a browser; the glue is notifications.ts.

export type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const DEVICE_KEY = "throne.deviceId";
/** The endpoint this device last saved to the server. */
export const SAVED_KEY = "throne.pushEndpoint";
/** Sign-out deletes that couldn't reach the server, by Profile: { [username]: deviceId[] }. */
const PENDING_KEY = "throne.pendingPushDeletes";

/** A random ID for this install. Re-enabling reuses it, so the server record is replaced. */
export function deviceId(store: KeyValue, newId: () => string = () => crypto.randomUUID()): string {
  let id = store.getItem(DEVICE_KEY);
  if (!id) store.setItem(DEVICE_KEY, (id = newId()));
  return id;
}

/**
 * Sign-out: forget this device's ID and saved endpoint, so the next Profile on this phone
 * subscribes as a new device. Returns the old ID (for deletePushSubscription), if there was one.
 */
export function forgetDevice(store: KeyValue): string | undefined {
  const id = store.getItem(DEVICE_KEY) ?? undefined;
  store.removeItem(DEVICE_KEY);
  store.removeItem(SAVED_KEY);
  return id;
}

function pending(store: KeyValue): Record<string, string[]> {
  try {
    return JSON.parse(store.getItem(PENDING_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Remember a delete that failed offline. Only `username` can delete their own record. */
export function queueDelete(store: KeyValue, username: string, id: string) {
  const all = pending(store);
  all[username] = [...new Set([...(all[username] ?? []), id])];
  store.setItem(PENDING_KEY, JSON.stringify(all));
}

/** The deletes queued for `username`, removed from the queue. */
export function takeDeletes(store: KeyValue, username: string): string[] {
  const all = pending(store);
  const ids = all[username] ?? [];
  delete all[username];
  if (Object.keys(all).length) store.setItem(PENDING_KEY, JSON.stringify(all));
  else store.removeItem(PENDING_KEY);
  return ids;
}
