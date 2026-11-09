import { describe, expect, it } from "vitest";
import { hasHiddenCharacters } from "./text";

describe("hasHiddenCharacters", () => {
  it("passes plain text and emoji, including joined emoji (ZWJ) and variation selectors", () => {
    for (const s of ["Sam", "José \u{1F4A9}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u2764\uFE0F", "日本"]) expect(hasHiddenCharacters(s)).toBe(false);
  });

  it("catches control characters, bidi overrides and zero-width spaces", () => {
    for (const s of ["a\u0007", "a\u202Eb", "a\u2066b", "a\u200Bb", "a\u200Eb", "a\uFEFFb", "a\nb"]) expect(hasHiddenCharacters(s)).toBe(true);
  });

  it("allows newlines only when asked", () => {
    expect(hasHiddenCharacters("a\nb", { newlines: true })).toBe(false);
    expect(hasHiddenCharacters("a\tb", { newlines: true })).toBe(true);
  });
});
