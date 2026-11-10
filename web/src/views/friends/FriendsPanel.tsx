import "./friends.css";
import { useEffect, useState } from "react";
import { MAX_FRIENDS, parseFriendCode, type Avatar } from "@throne/shared";
import {
  acceptFriendRequest, cancelFriendRequest, declineFriendRequest, endFriendship, loadFriends, regenerateFriendCode, sendFriendRequest,
  type FriendsState,
} from "../../api/friend";
import { plainMessage } from "../../api/profile";

/**
 * The Friends tab (/friends): my Friend code (share, regenerate), sending a Friend request by code,
 * incoming and sent requests, and my Friends (end a Friendship after a confirmation).
 */
export function FriendsPanel() {
  const [state, setState] = useState<FriendsState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = () => loadFriends().then(setState, (e) => setError(plainMessage(e)));
  useEffect(() => void reload(), []);

  /**
   * Run one change, then show the server's view again. Resolves to the error message if it failed (shown at
   * the top, unless `inline`: then the caller shows it next to what was tried), else undefined.
   */
  async function run(fn: () => Promise<unknown>, { inline = false } = {}): Promise<string | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await reload();
      return undefined;
    } catch (err) {
      const text = plainMessage(err);
      if (!inline) setError(text);
      return text;
    } finally {
      setBusy(false);
    }
  }

  if (!state) return error ? <p className="error" role="alert">{error}</p> : <p className="center">Loading…</p>;
  const full = state.friends.length >= MAX_FRIENDS;

  return (
    <div className="friends">
      {error && <p className="error" role="alert">{error}</p>}
      {state.requests.length > 0 && (
        <section className="card" aria-label="Friend requests">
          <h2>Friend requests</h2>
          <ul className="people">
            {state.requests.map((r) => (
              <li key={r.id}>
                <Person name={r.displayName} avatar={r.avatar} />
                <span className="actions">
                  <button type="button" className="primary" disabled={busy} onClick={() => void run(() => acceptFriendRequest(r.id))}>Accept</button>
                  <button type="button" disabled={busy} onClick={() => void run(() => declineFriendRequest(r.id))}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FriendList state={state} busy={busy} run={run} />
      <AddFriend busy={busy} full={full} run={run} />
      {state.sent.length > 0 && (
        <section className="card" aria-label="Sent requests">
          <h2>Sent requests</h2>
          <ul className="people">
            {state.sent.map((s) => (
              <li key={s.id}>
                <span>To <code className="friend-code">{s.code}</code></span>
                <button type="button" className="link danger" disabled={busy} onClick={() => void run(() => cancelFriendRequest(s.id))}>Cancel</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <MyCode code={state.code} busy={busy} run={run} />
    </div>
  );
}

function Person({ name, avatar }: { name: string; avatar: Avatar }) {
  return (
    <span className="person">
      <span className="avatar" style={{ background: avatar.color }} role="img" aria-label={`${name}'s Avatar`}>{avatar.emoji}</span>
      <span className="name">{name}</span>
    </span>
  );
}

type Run = (fn: () => Promise<unknown>, opts?: { inline?: boolean }) => Promise<string | undefined>;

function FriendList({ state, busy, run }: { state: FriendsState; busy: boolean; run: Run }) {
  const [ending, setEnding] = useState<string>();
  return (
    <section className="card" aria-label="Friends">
      <h2>Friends <span className="hint">{state.friends.length} of {MAX_FRIENDS}</span></h2>
      {state.friends.length === 0 ? (
        <p className="hint">No Friends yet. Share your Friend code, or enter someone else's below.</p>
      ) : (
        <ul className="people">
          {state.friends.map((f) => (
            <li key={f.id}>
              {ending === f.id ? (
                <div className="confirm" role="group" aria-label={`End Friendship with ${f.displayName}`}>
                  <p>End your Friendship with {f.displayName}? You'll both stop seeing each other's Logs.</p>
                  <span className="actions">
                    <button type="button" className="danger-fill" disabled={busy}
                      onClick={() => void run(() => endFriendship(f.id)).then((err) => err === undefined && setEnding(undefined))}>End Friendship</button>
                    <button type="button" disabled={busy} onClick={() => setEnding(undefined)}>Keep</button>
                  </span>
                </div>
              ) : (
                <>
                  <Person name={f.displayName} avatar={f.avatar} />
                  <button type="button" className="link danger" onClick={() => setEnding(f.id)}>End…</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Friends see all your Logs, Details and history included.</p>
    </section>
  );
}

function AddFriend({ busy, full, run }: { busy: boolean; full: boolean; run: Run }) {
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const code = parseFriendCode(typed);
    if (!code) return setStatus({ ok: false, text: "A Friend code is 6 letters and digits, like 4KQ-9XM." });
    setStatus(undefined);
    let outcome: "SENT" | "FRIENDS" | undefined;
    const err = await run(async () => (outcome = await sendFriendRequest(code)), { inline: true });
    if (err !== undefined) return setStatus({ ok: false, text: err });
    setTyped("");
    setStatus({ ok: true, text: outcome === "FRIENDS" ? "They had already asked you, so you're Friends now." : "Friend request sent." });
  }

  return (
    <form className="card" aria-label="Add a Friend" onSubmit={send}>
      <h2>Add a Friend</h2>
      {full ? (
        <p className="hint">You have {MAX_FRIENDS} Friends, the most there can be. End a Friendship to add someone else.</p>
      ) : (
        <>
          <label>
            Their Friend code
            <input value={typed} placeholder="4KQ-9XM" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={12}
              onChange={(e) => { setTyped(e.target.value); setStatus(undefined); }} />
          </label>
          <button className="primary" disabled={busy || !typed.trim()}>Send Friend request</button>
        </>
      )}
      {status && <p className={status.ok ? "hint" : "error"} role={status.ok ? "status" : "alert"}>{status.text}</p>}
    </form>
  );
}

function MyCode({ code, busy, run }: { code: string; busy: boolean; run: Run }) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function share() {
    const text = `My Throne Friend code is ${code}`;
    if (navigator.share) {
      await navigator.share({ text }).catch(() => {});
      return;
    }
    await navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {});
  }

  return (
    <section className="card" aria-label="Your Friend code">
      <h2>Your Friend code</h2>
      <code className="friend-code big" aria-label="Friend code">{code}</code>
      <p className="hint">Send it to someone yourself (a text, in person). Anyone with it can send you a Friend request; you choose whether to accept.</p>
      {confirming ? (
        <div className="confirm" role="group" aria-label="Regenerate Friend code">
          <p>Make a new code? The old one stops working.</p>
          <span className="actions">
            <button type="button" className="primary" disabled={busy}
              onClick={() => void run(regenerateFriendCode).then((err) => { if (err === undefined) { setConfirming(false); setCopied(false); } })}>New code</button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Keep this one</button>
          </span>
        </div>
      ) : (
        <span className="actions">
          <button type="button" onClick={() => void share()}>{copied ? "Copied" : "Share code"}</button>
          <button type="button" className="link" onClick={() => setConfirming(true)}>Regenerate</button>
        </span>
      )}
    </section>
  );
}
