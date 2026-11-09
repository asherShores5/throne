// Invite rules (GLOSSARY: Invite). Pure, shared by the api (create, revoke, the pre-sign-up trigger)
// and the web client (the link it shares and the Invite landing page). The api mints tokens.

/** An Invite is open for 7 days after it is made. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A Profile has at most this many open Invites; making another is refused. */
export const MAX_OPEN_INVITES = 3;

/**
 * 128 random bits as unpadded base64url: 22 characters, the last of which carries only 2 bits
 * (so it is one of A, Q, g, w). Anything else can't be a token the api made.
 */
export function isInviteToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(t);
}

/** The link a Profile shares. The token is after `#`, so browsers never send it to CloudFront. */
export const inviteLink = (origin: string, token: string) => `${origin}/invite#${token}`;

/** The token from an Invite link's `location.hash`, or undefined if there is none that could be valid. */
export function inviteTokenFromHash(hash: string): string | undefined {
  const t = hash.replace(/^#/, "");
  return isInviteToken(t) ? t : undefined;
}
