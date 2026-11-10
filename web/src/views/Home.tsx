import { useEffect, useState } from "react";
import { signOut } from "../auth";
import { releaseThisDevice, sendQueuedDeletes } from "../notifications";
import type { Profile } from "../api/profile";
import { onLink } from "../route";
import { loadMeCached } from "../sync/profileCache";
import "./profile.css";
import { Calendar } from "./calendar/Calendar";
import { FriendsPanel } from "./friends/FriendsPanel";
import { LogPanel } from "./log/LogPanel";
import { LatestSummaryCard } from "./summary/SummaryScreen";

export type HomeView = "log" | "calendar" | "friends";

/**
 * The signed-in home screen, three tabs: Log ("/": the Log button and recent Logs, views/log/),
 * Calendar ("/calendar": my month, a Friend's, or everyone's, views/calendar/) and Friends ("/friends": views/friends/). Loading it
 * also creates the Profile on a first sign-in (api/profile.ts); offline it opens with the last copy
 * (sync/profileCache.ts).
 */
export function Home({ view = "log" }: { view?: HomeView }) {
  const [me, setMe] = useState<Profile>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    loadMeCached().then(setMe, (e) => setError((e as Error).message));
    // A push sign-out delete that couldn't go out offline (notifications.ts).
    void sendQueuedDeletes().catch(() => {});
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
        {tab("/friends", "Friends", "friends")}
      </nav>
      {error && <p className="error" role="alert">{error}</p>}
      {!me ? (
        !error && <p className="center">Loading…</p>
      ) : view === "friends" ? (
        <FriendsPanel />
      ) : view === "calendar" ? (
        <Calendar me={me} />
      ) : (
        <section aria-label="Home" className="empty-home">
          <p>Hi, {me.displayName}.</p>
          <LogPanel homeZone={me.homeZone} meId={me.id} />
          <LatestSummaryCard />
        </section>
      )}
      <button type="button" className="link sign-out" onClick={() => void releaseThisDevice().finally(signOut)}>Sign out</button>
    </main>
  );
}
