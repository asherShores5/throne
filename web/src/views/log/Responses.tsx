// Reactions and Comments under one Log. The server already sent only what the viewer may see (the owner:
// everyone's; a Friend: their own), so this shows all it gets. On a Friend's Log: the 6 Reactions (tap the
// lit one again to take it off) and a Comment box. Comments can be deleted by their author, and by the Log's
// owner. Online only (not in the outbox): a failure shows here and nothing changes.
import { useState, type FormEvent } from "react";
import { COMMENT_MAX, REACTION_EMOJI, parseCommentText, type Avatar } from "@throne/shared";
import { errorText, type Log } from "../../api/log";
import { addComment, deleteComment, setReaction } from "../../api/reaction";

/** Who an author id is, for names on Reactions and Comments. */
export type Directory = ReadonlyMap<string, { name: string; avatar?: Avatar }>;

export function Responses({ log, owner, viewer, people, onChanged }: {
  log: Log & { pending?: true };
  /** The Log owner's Profile id. */
  owner: string;
  /** The signed-in Profile's id. */
  viewer: string;
  people: Directory;
  /** The Log as the server now has it (after a Reaction or Comment change). */
  onChanged: (l: Log) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const mineLog = owner === viewer;
  const name = (id: string) => (id === viewer ? "You" : people.get(id)?.name ?? "A Friend");
  const myReaction = log.reactions.find((r) => r.author === viewer)?.emoji;

  async function run(fn: () => Promise<Log>) {
    setBusy(true);
    setError(undefined);
    try {
      onChanged(await fn());
      return true;
    } catch (e) {
      setError(errorText(e as Error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const p = parseCommentText(text);
    if (!p.ok) return setError(p.error);
    if (await run(() => addComment(owner, log.id, p.text))) {
      setText("");
      setWriting(false);
    }
  }

  const nothing = !log.reactions.length && !log.comments.length;
  if (mineLog && nothing) return null;
  return (
    <div className="responses">
      {mineLog && log.reactions.length > 0 && (
        <ul className="reactions" aria-label="Reactions">
          {log.reactions.map((r) => (
            <li key={r.author} className="reaction" aria-label={`${name(r.author)} reacted ${r.emoji}`}>
              <span aria-hidden="true">{r.emoji} {name(r.author)}</span>
            </li>
          ))}
        </ul>
      )}
      {!mineLog && (
        <div className="react-bar" role="group" aria-label="React">
          {REACTION_EMOJI.map((emoji) => (
            <button
              type="button" key={emoji} className="react" aria-pressed={myReaction === emoji} disabled={busy}
              aria-label={`React ${emoji}`} onClick={() => void run(() => setReaction(owner, log.id, myReaction === emoji ? null : emoji))}
            >
              {emoji}
            </button>
          ))}
          {!writing && <button type="button" className="link" onClick={() => setWriting(true)}>Comment</button>}
        </div>
      )}
      {log.comments.length > 0 && (
        <ul className="comments" aria-label="Comments">
          {log.comments.map((c) => (
            <li key={c.id} className="comment">
              <span><strong>{name(c.author)}</strong> {c.text}</span>
              {(mineLog || c.author === viewer) && (
                <button
                  type="button" className="link" disabled={busy} aria-label={`Delete Comment from ${name(c.author)}`}
                  onClick={() => void run(() => deleteComment(owner, log.id, c.id))}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {writing && (
        <form className="comment-form" onSubmit={send}>
          <input
            aria-label="Comment" placeholder="Say something" value={text} autoFocus
            maxLength={COMMENT_MAX * 2} onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !text.trim()}>Send</button>
          <button type="button" className="link" onClick={() => { setWriting(false); setText(""); setError(undefined); }}>Cancel</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
