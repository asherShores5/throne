import { useEffect, useState } from "react";
import { signOut } from "../auth";
import { loadMe, type Profile } from "../api/profile";

/**
 * The signed-in home screen. Empty for now: ticket 03 adds the Log button, 05 the Calendar.
 * Loading it also creates the Profile on a first sign-in (api/profile.ts).
 */
export function Home() {
  const [me, setMe] = useState<Profile>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    loadMe().then(setMe, (e) => setError((e as Error).message));
  }, []);

  return (
    <main className="home">
      <header className="topbar">
        <h1>Throne</h1>
        {me && (
          <span className="avatar" style={{ background: me.avatar.color }} role="img" aria-label={`${me.displayName}'s Avatar`}>
            {me.avatar.emoji}
          </span>
        )}
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {me ? (
        <section aria-label="Home" className="empty-home">
          <p>Hi, {me.displayName}.</p>
          <p className="hint">Nothing here yet.</p>
        </section>
      ) : (
        !error && <p className="center">Loading…</p>
      )}
      <button type="button" className="link sign-out" onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}
