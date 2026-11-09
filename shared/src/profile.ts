// A Profile's own fields (GLOSSARY: Profile, Display name, Avatar, Home zone). Pure, shared by the
// api (what it stores) and the web client (what it offers to pick).

/** Avatar emoji choices; the first is the default for a new Profile. */
export const AVATAR_EMOJI = ["🚽", "👑", "🦆", "🐸", "🐙", "🦊", "🐼", "🌵", "🍑", "🌈", "⭐", "🔥"] as const;

/** Avatar colors: a fixed palette of 8, readable behind an emoji in light and dark. The first is the default. */
export const AVATAR_COLORS = ["#7c5cff", "#e8590c", "#2b8a3e", "#1c7ed6", "#d6336c", "#f0b400", "#0c8599", "#868e96"] as const;

export const DISPLAY_NAME_MAX = 24;
/** What a Profile is called until its owner names it (ticket 02 adds the sign-up form). */
export const PLACEHOLDER_DISPLAY_NAME = "New Profile";

export interface Avatar {
  emoji: string;
  color: string;
}

export interface ProfileFields {
  displayName: string;
  avatar: Avatar;
  homeZone: string;
}

/** Home zone when the device gives none we can use. */
export const DEFAULT_HOME_ZONE = "UTC";

/** An IANA time zone name the runtime knows (e.g. "America/Los_Angeles"). Offsets like "-08:00" are refused. */
export function isHomeZone(z: unknown): z is string {
  if (typeof z !== "string" || !z || z.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(z)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

export const homeZoneOr = (z: unknown): string => (isHomeZone(z) ? z : DEFAULT_HOME_ZONE);

/**
 * A Display name as stored: trimmed, 1 to DISPLAY_NAME_MAX characters (an emoji counts as one), no
 * control characters. Undefined if it can't be one.
 */
export function cleanDisplayName(n: unknown): string | undefined {
  if (typeof n !== "string") return undefined;
  const t = n.trim();
  const len = [...t].length;
  if (len < 1 || len > DISPLAY_NAME_MAX || /\p{Cc}/u.test(t)) return undefined;
  return t;
}

/** An Avatar from the fixed choices: an emoji from AVATAR_EMOJI on a color from AVATAR_COLORS, nothing else. */
export function isAvatar(a: unknown): a is Avatar {
  if (!a || typeof a !== "object") return false;
  const { emoji, color, ...rest } = a as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    (AVATAR_EMOJI as readonly unknown[]).includes(emoji) &&
    (AVATAR_COLORS as readonly unknown[]).includes(color)
  );
}

/** A brand-new Profile: placeholder Display name, default Avatar, Home zone from the device. */
export function newProfile(deviceZone: unknown): ProfileFields {
  return {
    displayName: PLACEHOLDER_DISPLAY_NAME,
    avatar: { emoji: AVATAR_EMOJI[0], color: AVATAR_COLORS[0] },
    homeZone: homeZoneOr(deviceZone),
  };
}

/** Delete Profile asks for this word to be typed, so it can't happen by a stray tap. */
export const DELETE_CONFIRM_WORD = "delete";

export const isDeleteConfirmed = (typed: unknown): boolean => typeof typed === "string" && typed.trim().toLowerCase() === DELETE_CONFIRM_WORD;
