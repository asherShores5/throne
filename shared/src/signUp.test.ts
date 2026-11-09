import { describe, expect, it } from "vitest";
import { PASSWORD_MIN, cleanUsername, passwordProblem } from "./signUp";

describe("username (what a Profile signs in with; never shown to Friends)", () => {
  it("is lowercased and trimmed, 3 to 32 of a-z 0-9 . _ -", () => {
    expect(cleanUsername("  Sam.Jones ")).toBe("sam.jones");
    expect(cleanUsername("a_b-c")).toBe("a_b-c");
    for (const u of ["", "ab", "a".repeat(33), "sam jones", "sam@x", "émile", 5, null]) expect(cleanUsername(u)).toBeUndefined();
  });
});

describe("password (the user pool's policy, infra/lib/stacks.ts)", () => {
  it("needs 16+ characters with a lowercase letter, an uppercase letter and a digit", () => {
    expect(PASSWORD_MIN).toBe(16);
    expect(passwordProblem("Correct horse 42")).toBeUndefined();
    expect(passwordProblem("Short1a")).toMatch(/16/);
    expect(passwordProblem("alllowercase12345")).toMatch(/uppercase/);
    expect(passwordProblem("ALLUPPERCASE12345")).toMatch(/lowercase/);
    expect(passwordProblem("NoDigitsAtAllHere")).toMatch(/digit/);
  });
});
