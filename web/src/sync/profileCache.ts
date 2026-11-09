// The signed-in Profile, with the last copy kept on the device so Home (and the Log button) still opens
// with no signal. Online it always loads fresh (the first call also creates the Profile).
import { currentUsername } from "../auth";
import { NetworkError } from "../api/errors";
import { loadMe, type Profile } from "../api/profile";

const KEY = "throne.me.v1:";

export async function loadMeCached(): Promise<Profile> {
  const key = KEY + (currentUsername() ?? "");
  try {
    const me = await loadMe();
    try {
      localStorage.setItem(key, JSON.stringify(me));
    } catch {
      // Storage full or blocked: fine, it just won't open offline next time.
    }
    return me;
  } catch (e) {
    const cached = e instanceof NetworkError ? localStorage.getItem(key) : null;
    if (!cached) throw e;
    return JSON.parse(cached) as Profile;
  }
}
