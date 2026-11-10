import { describe, expect, it } from "vitest";
import {
  COMMENT_MAX, COMMENTS_PER_AUTHOR_MAX, REACTION_EMOJI, isReactionEmoji, parseCommentText, visibleResponses, withoutAuthor, type Responses,
} from "./reaction";

const R: Required<Responses> = {
  reactions: { b: "👏", c: "😂" },
  comments: [
    { id: "2", author: "c", text: "later", at: "2026-11-09T10:00:00.000Z" },
    { id: "1", author: "b", text: "first", at: "2026-11-09T09:00:00.000Z" },
  ],
};

describe("Reactions", () => {
  it("are 6 fixed emoji; anything else is refused", () => {
    expect(REACTION_EMOJI).toHaveLength(6);
    expect(new Set(REACTION_EMOJI).size).toBe(6);
    expect(isReactionEmoji("👏")).toBe(true);
    expect(isReactionEmoji("🍕")).toBe(false);
    expect(isReactionEmoji(undefined)).toBe(false);
  });
});

describe("Comment text", () => {
  it("is trimmed, 1 to 200 characters (emoji count as one)", () => {
    expect(parseCommentText("  nice  ")).toEqual({ ok: true, text: "nice" });
    expect(parseCommentText("   ").ok).toBe(false);
    expect(parseCommentText(42).ok).toBe(false);
    expect(parseCommentText("x".repeat(COMMENT_MAX)).ok).toBe(true);
    expect(parseCommentText("x".repeat(COMMENT_MAX + 1)).ok).toBe(false);
    expect(parseCommentText("💩".repeat(COMMENT_MAX)).ok).toBe(true);
  });

  it("has a cap of 20 per author per Log", () => {
    expect(COMMENTS_PER_AUTHOR_MAX).toBe(20);
  });
});

describe("visibleResponses", () => {
  it("the Log owner sees every Reaction and Comment, Comments oldest first", () => {
    expect(visibleResponses(R, "a", "a")).toEqual({
      reactions: [{ author: "b", emoji: "👏" }, { author: "c", emoji: "😂" }],
      comments: [R.comments[1], R.comments[0]],
    });
  });

  it("a Friend sees only their own", () => {
    expect(visibleResponses(R, "a", "b")).toEqual({ reactions: [{ author: "b", emoji: "👏" }], comments: [R.comments[1]] });
    expect(visibleResponses(R, "a", "d")).toEqual({ reactions: [], comments: [] });
  });

  it("works on a Log nobody has responded to", () => {
    expect(visibleResponses({}, "a", "a")).toEqual({ reactions: [], comments: [] });
  });
});

describe("withoutAuthor", () => {
  it("drops one author's Reaction and Comments, keeps everyone else's", () => {
    expect(withoutAuthor(R, "b")).toEqual({ reactions: { c: "😂" }, comments: [R.comments[0]] });
    expect(withoutAuthor({}, "b")).toEqual({ reactions: {}, comments: [] });
  });
});
