// Friend rules (GLOSSARY: Friend, Friendship, Friend request, Friend code). Pure, shared by the api
// (minting, lookup, limits) and the web client (what it shows and accepts as typed). The api supplies
// the random bytes for a new code.

/** No look-alikes: no 0/O, 1/I/L. 31 characters, so a code is one of 31^6 (about 887 million). */
export const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const FRIEND_CODE_LENGTH = 6;

/** A Profile has at most this many Friends; a Friendship that would go past it is refused on both sides. */
export const MAX_FRIENDS = 3;

/** Sending is capped per Profile per rolling day, so Friend codes can't be guessed by brute force. */
export const FRIEND_REQUESTS_PER_WINDOW = 10;
export const FRIEND_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Friend requests a Profile may have waiting at once (ticket 12, a record cap): requests never expire, so without
 * it 10 a day would pile up forever. With at most 3 Friends, more than 5 waiting is never needed.
 */
export const MAX_PENDING_SENT = 5;

const N = FRIEND_CODE_ALPHABET.length;
/** Bytes at or above this would make the first characters likelier; they're skipped. */
const UNBIASED_BELOW = 256 - (256 % N);

/** A code (6 characters, no dash) from random bytes, or undefined if they ran out first. */
export function friendCodeFrom(bytes: Iterable<number>): string | undefined {
  let code = "";
  for (const b of bytes) {
    if (b >= UNBIASED_BELOW) continue;
    code += FRIEND_CODE_ALPHABET[b % N];
    if (code.length === FRIEND_CODE_LENGTH) return code;
  }
  return undefined;
}

/** How a code is shown: two groups of 3, e.g. 4KQ-9XM. */
export const formatFriendCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

/** A code as stored (6 characters, no dash) from what a person typed: any case; spaces and dashes ignored. */
export function parseFriendCode(typed: unknown): string | undefined {
  if (typeof typed !== "string") return undefined;
  const code = typed.toUpperCase().replace(/[\s\-‐-―]/g, "");
  if (code.length !== FRIEND_CODE_LENGTH) return undefined;
  return [...code].every((c) => FRIEND_CODE_ALPHABET.includes(c)) ? code : undefined;
}

/** The send times (ms) still inside the rolling day ending at `now`. */
export const sendsInWindow = (times: number[], now: number) => times.filter((t) => t > now - FRIEND_REQUEST_WINDOW_MS);
