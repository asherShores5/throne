// After Delete Profile: everything this device kept for that Profile goes too (pure over a key-value store; the
// glue is account.ts). Another Profile's data on a shared phone stays.
import { forgetDevice, takeDeletes, type KeyValue } from "./pushDevice";
import { HAS_PASSKEY, LAST_USER, LOGS_CACHE, LOGS_OUTBOX, PROFILE_CACHE } from "./storageKeys";

/**
 * After Sign out (spec: "so that I can hand my phone to someone"): the copy of their Logs and Profile goes, so nobody
 * with the phone can read it. Only Log writes not sent yet stay (deleting them would lose Logs), and they're sent
 * at the next sign-in as this Profile.
 */
export function forgetOnSignOut(store: KeyValue, username: string) {
  for (const prefix of [LOGS_CACHE, PROFILE_CACHE]) store.removeItem(prefix + username);
}

export function forgetProfileHere(store: KeyValue, username: string) {
  for (const prefix of [LOGS_CACHE, LOGS_OUTBOX, PROFILE_CACHE]) store.removeItem(prefix + username);
  takeDeletes(store, username); // their queued push deletes: the server already deleted every device
  forgetDevice(store);
  store.removeItem(HAS_PASSKEY);
  if (store.getItem(LAST_USER) === username) store.removeItem(LAST_USER);
}
