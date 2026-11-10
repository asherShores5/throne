// Characters people's text may not carry (ticket 12): control characters, and invisible format characters
// such as bidi overrides (U+202E makes "evil.exe" look like "exe.live") or zero-width spaces, which can
// spoof a Display name in a push or a Friends list. The zero-width joiner (U+200D) is allowed: emoji like
// 👨‍👩‍👧 are built with it.

/** True if `s` has a control character (other than the allowed ones) or an invisible format character. */
export function hasHiddenCharacters(s: string, allow: { newlines?: boolean } = {}): boolean {
  const cc = allow.newlines ? /[^\P{Cc}\n]/u : /\p{Cc}/u;
  // Emoji tag sequences (subdivision flags) use U+E0020-E007F, also format characters: allowed too.
  return cc.test(s) || /\p{Cf}/u.test(s.replace(/[\u200D\u{E0020}-\u{E007F}]/gu, ""));
}
