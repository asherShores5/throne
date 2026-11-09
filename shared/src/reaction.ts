// Reaction and Comment rules (GLOSSARY: Reaction, Comment). Pure, shared by the api (what it stores and
// who may see what) and the web client (the picker and the Comment box). Both live on the Log they
// answer, so deleting the Log deletes them.

/** The 6 fixed Reactions, in picker order. */
export const REACTION_EMOJI = ["👏", "😂", "😮", "😬", "💪", "💩"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export const isReactionEmoji = (v: unknown): v is ReactionEmoji => typeof v === "string" && (REACTION_EMOJI as readonly string[]).includes(v);

/** A Comment is at most this many characters (an emoji counts as one). */
export const COMMENT_MAX = 200;
/** Comments per Log, everyone's together: a record cap that protects cost and item size. */
export const COMMENTS_PER_LOG_MAX = 20;

export function parseCommentText(v: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "A Comment is text." };
  const text = v.trim();
  if (!text) return { ok: false, error: "A Comment can't be empty." };
  if ([...text].length > COMMENT_MAX) return { ok: false, error: `A Comment is at most ${COMMENT_MAX} characters.` };
  return { ok: true, text };
}

export interface Comment {
  id: string;
  /** The author's Profile id. */
  author: string;
  text: string;
  /** ISO 8601 UTC. */
  at: string;
}

export interface Reaction {
  author: string;
  emoji: string;
}

/** What a Log stores: one Reaction per author (author -> emoji) and every Comment. */
export interface Responses {
  reactions?: Record<string, string>;
  comments?: Comment[];
}

/**
 * What `viewer` may see on a Log `owner` made: the owner sees everything; anyone else sees only what they
 * wrote (two of the owner's Friends who aren't Friends with each other never see each other's).
 */
export function visibleResponses(r: Responses, owner: string, viewer: string): { reactions: Reaction[]; comments: Comment[] } {
  const mine = (author: string) => viewer === owner || author === viewer;
  return {
    reactions: Object.entries(r.reactions ?? {})
      .filter(([author]) => mine(author))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([author, emoji]) => ({ author, emoji })),
    comments: (r.comments ?? []).filter((c) => mine(c.author)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  };
}

/** The Log's Responses with everything `author` left removed (an ended Friendship). */
export function withoutAuthor(r: Responses, author: string): { reactions: Record<string, string>; comments: Comment[] } {
  const { [author]: _gone, ...reactions } = r.reactions ?? {};
  return { reactions, comments: (r.comments ?? []).filter((c) => c.author !== author) };
}

/** True when `author` still has a Reaction or a Comment on the Log. */
export const hasResponsesFrom = (r: Responses, author: string) =>
  !!r.reactions?.[author] || (r.comments ?? []).some((c) => c.author === author);
