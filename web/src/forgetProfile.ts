// After Delete Profile: everything this device kept for that Profile goes too (pure over a key-value store; the
// glue is account.ts). Another Profile's data on a shared phone stays.
import { forgetDevice, takeDeletes, type KeyValue } from "./pushDevice";
import { HAS_PASSKEY, LAST_USER, LOGS_CACHE, LOGS_OUTBOX, PROFILE_CACHE } from "./storageKeys";

export function forgetProfileHere(store: KeyValue, username: string) {
  for (const prefix of [LOGS_CACHE, LOGS_OUTBOX, PROFILE_CACHE]) store.removeItem(prefix + username);
  takeDeletes(store, username); // their queued push deletes: the server already deleted every device
  forgetDevice(store);
  store.removeItem(HAS_PASSKEY);
  if (store.getItem(LAST_USER) === username) store.removeItem(LAST_USER);
}
