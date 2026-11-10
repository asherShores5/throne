import { useState } from "react";
import { DELETED_NOTICE } from "../account";
import { lastUsername, signInWithPasskey, signInWithPassword } from "../auth";

/**
 * Sign-in: a passkey first (Face ID on iPhone; iCloud Keychain or a phone QR on desktop), with the
 * password one tap away as the backup. There is no sign-up form: a Profile starts from an Invite link.
 */
export function Login() {
  const [username, setUsername] = useState(lastUsername() ?? "");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Shown once, right after Delete Profile signed this device out.
  const [deleted] = useState(() => {
    const was = sessionStorage.getItem(DELETED_NOTICE) === "1";
    sessionStorage.removeItem(DELETED_NOTICE);
    return was;
  });

  async function run(e: React.FormEvent, signIn: () => Promise<void>) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function switchTo(password: boolean) {
    setUsePassword(password);
    setPassword("");
    setError(undefined);
  }

  return (
    <form className="login" aria-label="Sign in" onSubmit={(e) => run(e, () => (usePassword ? signInWithPassword(username, password) : signInWithPasskey(username)))}>
      <div className="brand" aria-hidden="true">
        <img src="/favicon.svg" alt="" width="56" height="56" />
      </div>
      <h1>Throne</h1>
      {deleted && <p className="hint" role="status">Your Profile is deleted. Everything you made is gone.</p>}
      <input autoComplete={usePassword ? "username" : "username webauthn"} placeholder="Username" aria-label="Username" value={username}
        onChange={(e) => setUsername(e.target.value)} autoFocus={!username} autoCapitalize="none" />
      {usePassword ? (
        <>
          <input type="password" autoComplete="current-password" placeholder="Password" aria-label="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoFocus />
          <button className="primary" disabled={busy || !username.trim() || !password}>Sign in with password</button>
          <button type="button" className="link" onClick={() => switchTo(false)}>Use a passkey instead</button>
        </>
      ) : (
        <>
          <button className="primary" disabled={busy || !username.trim()}>Sign in with passkey</button>
          <p className="hint">Face ID on iPhone. On a computer, use its passkey or scan the QR code with your phone.</p>
          <button type="button" className="link" onClick={() => switchTo(true)}>Use password instead</button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="invite-only">
        Throne is invite-only. To join, ask someone who has a Profile to send you an Invite link.
      </p>
    </form>
  );
}
