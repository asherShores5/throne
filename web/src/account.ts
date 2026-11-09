// Delete Profile on this device (ticket 11). The server does the deleting (deleteProfile, which also deletes the
// Cognito user); this file then forgets the Profile here and signs out.
//
// A deletion stopped half way (the app closed, no signal) is finished on its own: once it has started, every
// other API call answers ProfileDeleted, and gql.ts hands that here, which asks the server to finish and then
// forgets and signs out. Another phone still signed in to the deleted Profile ends up the same way.
import { deleteProfile } from "./api/profile";
import { onProfileDeleted } from "./api/gql";
import { currentUsername, signOut } from "./auth";
import { forgetProfileHere } from "./forgetProfile";
import { releaseLocally } from "./notifications";
import { navigate } from "./route";

/** sessionStorage flag: the sign-in screen says the Profile is deleted. */
export const DELETED_NOTICE = "throne.profileDeleted";

let finishing: Promise<void> | undefined;

async function forgetAndSignOut(username: string | undefined) {
  if (username) forgetProfileHere(localStorage, username);
  await releaseLocally();
  sessionStorage.setItem(DELETED_NOTICE, "1");
  navigate("/", { replace: true });
  await signOut(); // its RevokeToken fails quietly: the Profile and its username are gone
}

/** Delete the signed-in Profile for good. Rejects (and changes nothing here) if the server couldn't finish. */
export async function deleteMyProfile(): Promise<void> {
  const username = currentUsername();
  await deleteProfile();
  await forgetAndSignOut(username);
}

onProfileDeleted(() => {
  finishing ??= (async () => {
    const username = currentUsername();
    // Best effort: offline, the next sign-in gets ProfileDeleted again and finishes then.
    await deleteProfile().catch(() => {});
    await forgetAndSignOut(username);
  })().finally(() => (finishing = undefined));
});
