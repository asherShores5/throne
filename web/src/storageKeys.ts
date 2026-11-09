// localStorage keys that hold one Profile's data on this device, in one place so Delete Profile
// (forgetProfile.ts) forgets all of them. Per-Profile keys end in the username.

/** The last copy of my Logs loaded from the API (sync/logs.ts). */
export const LOGS_CACHE = "throne.logs.v1:";
/** Log writes not yet confirmed (sync/logs.ts). */
export const LOGS_OUTBOX = "throne.outbox.v1:";
/** The last Profile loaded, so Home opens offline (sync/profileCache.ts). */
export const PROFILE_CACHE = "throne.me.v1:";
/** Last username signed in on this device, so the sign-in screen is one tap (auth.ts). */
export const LAST_USER = "throne.lastUser";
/** Set once this device has added a passkey for the signed-in Profile (auth.ts). */
export const HAS_PASSKEY = "throne.hasPasskey";
