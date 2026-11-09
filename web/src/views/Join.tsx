import { useState } from "react";
import { AVATAR_COLORS, AVATAR_EMOJI, cleanDisplayName, cleanUsername, inviteTokenFromHash, passwordProblem, type Avatar } from "@throne/shared";
import { InviteRefusedError, isSignedIn, signUpWithInvite } from "../auth";
import { deviceZone, updateProfile } from "../api/profile";
import { navigate, onLink } from "../route";
import { AvatarPicker } from "./AvatarPicker";

/**
 * The Invite landing page (/invite#<token>). Visitors can't call the API, so whether an Invite is still
 * open is only known when Cognito's pre-sign-up trigger checks it: a malformed link is refused here, a
 * spent, revoked or expired one when the form is sent. Either way: ask for a new Invite.
 */
export function Join() {
  const [token] = useState(() => inviteTokenFromHash(location.hash));
  const [alreadyIn] = useState(isSignedIn);
  const [refused, setRefused] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [avatar, setAvatar] = useState<Avatar>({ emoji: AVATAR_EMOJI[0], color: AVATAR_COLORS[0] });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (alreadyIn) {
    return (
      <main className="login">
        <h1>You're already signed in</h1>
        <p className="hint">This Invite is for someone without a Profile. Send them the link.</p>
        <a className="button primary" href="/" onClick={onLink("/")}>Go to Throne</a>
      </main>
    );
  }

  if (!token || refused) {
    return (
      <main className="login" aria-label="Invite">
        <div className="brand" aria-hidden="true"><img src="/favicon.svg" alt="" width="56" height="56" /></div>
        <h1>This Invite can't be used</h1>
        <p>It may have expired, been revoked or already been used. Ask for a new Invite from someone who has a Profile.</p>
        <a className="link" href="/" onClick={onLink("/")}>Sign in instead</a>
      </main>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    // Check everything first: a sign-up Cognito refuses for another reason could still spend the Invite.
    const name = cleanDisplayName(displayName);
    if (!name) return setError("Pick a Display name of 1 to 24 characters.");
    const user = cleanUsername(username);
    if (!user) return setError("A username is 3 to 32 letters, digits, dots, dashes or underscores.");
    const bad = passwordProblem(password);
    if (bad) return setError(`Password: ${bad} (at least 16 characters, with upper and lower case letters and a digit)`);
    setBusy(true);
    try {
      await signUpWithInvite(token!, user, password);
    } catch (err) {
      setBusy(false);
      if (err instanceof InviteRefusedError) return setRefused(true);
      return setError((err as Error).message);
    }
    // Signed in. Name the new Profile; if this fails it keeps the placeholder and Settings can fix it.
    await updateProfile({ displayName: name, avatar, homeZone: deviceZone() }).catch(() => {});
    navigate("/settings?welcome", { replace: true });
  }

  return (
    <form className="login join" aria-label="Join Throne" onSubmit={submit}>
      <div className="brand" aria-hidden="true"><img src="/favicon.svg" alt="" width="56" height="56" /></div>
      <h1>Join Throne</h1>
      <p className="hint">
        Someone sent you an Invite. Joining doesn't make you Friends with them: once you're in, swap Friend codes.
      </p>
      <label>
        Display name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={48} autoComplete="nickname" autoFocus />
      </label>
      <span className="hint">What your Friends see. Avatar:</span>
      <AvatarPicker value={avatar} onChange={setAvatar} />
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <span className="hint">You sign in with these; nobody else sees them. 16+ characters with upper and lower case and a digit. You can add Face ID next.</span>
      <button className="primary" disabled={busy}>Create my Profile</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
