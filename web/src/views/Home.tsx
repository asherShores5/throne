import { useEffect, useState } from "react";
import { signOut } from "../auth";
import { myLogs } from "../api/log";
import { loadMe, type Profile } from "../api/profile";
import { onLink } from "../route";
import "./profile.css";
import { PersonCalendar } from "./calendar/PersonCalendar";
import { LogPanel } from "./log/LogPanel";

export type HomeView = "log" | "calendar";

/**
 * The signed-in home screen, two tabs: Log ("/": the Log button and recent Logs, views/log/) and
 * Calendar ("/calendar": my month, views/calendar/). Loading it also creates the Profile on a first
 * sign-in (api/profile.ts).
 */
export function Home({ view = "log" }: { view?: HomeView }) {
  const [me, setMe] = useState<Profile>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    loadMe().then(setMe, (e) => setError((e as Error).message));
  }, []);

  const tab = (to: string, name: string, v: HomeView) => (
    <a href={to} onClick={onLink(to)} aria-current={view === v ? "page" : undefined}>{name}</a>
  );

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
      <nav className="tabs" aria-label="Views">
        {tab("/", "Log", "log")}
        {tab("/calendar", "Calendar", "calendar")}
      </nav>
      {error && <p className="error" role="alert">{error}</p>}
      {!me ? (
        !error && <p className="center">Loading…</p>
      ) : view === "calendar" ? (
        <PersonCalendar loadLogs={myLogs} viewerZone={me.homeZone} editable />
      ) : (
        <section aria-label="Home" className="empty-home">
          <p>Hi, {me.displayName}.</p>
          <LogPanel homeZone={me.homeZone} />
        </section>
      )}
      <button type="button" className="link sign-out" onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}
