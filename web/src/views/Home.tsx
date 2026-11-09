import { useEffect, useState } from "react";
import { signOut } from "../auth";
import { loadMe, type Profile } from "../api/profile";
import { onLink } from "../route";
import "./profile.css";
import { LogPanel } from "./log/LogPanel";

/**
 * The signed-in home screen: the Log button and recent Logs (views/log/, ticket 03); 05 adds the Calendar.
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
          <a href="/settings" onClick={onLink("/settings")} aria-label="Settings" className="avatar-link">
            <span className="avatar" style={{ background: me.avatar.color }} role="img" aria-label={`${me.displayName}'s Avatar`}>
              {me.avatar.emoji}
            </span>
          </a>
        )}
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {me ? (
        <section aria-label="Home" className="empty-home">
          <p>Hi, {me.displayName}.</p>
          <LogPanel homeZone={me.homeZone} />
        </section>
      ) : (
        !error && <p className="center">Loading…</p>
      )}
      <button type="button" className="link sign-out" onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}
