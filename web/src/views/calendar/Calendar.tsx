// The Calendar tab: an Avatar row above the month (Me, each Friend, Everyone) picks whose Calendar it is.
// Me is my own, editable, including Logs still waiting to sync; a Friend's is read-only on their own Days;
// Everyone is the combined grid. The row appears once I have a Friend; the Friends list reloads with the
// month (focus), so an ended Friendship drops out and its Calendar goes back to Me.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listFriends, type Friend } from "../../api/friend";
import type { Profile } from "../../api/profile";
import { calendarLink } from "../../deepLink";
import { useSearch } from "../../route";
import { MonthCalendar, type Person } from "./MonthCalendar";
import { useRefreshOnFocus } from "./refresh";

const EVERYONE = "everyone";

export function Calendar({ me }: { me: Profile }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  // A push's Day link ("/calendar?who=<sub>&day=<Day>") picks whose Calendar and opens that Day.
  const search = useSearch();
  const link = calendarLink(search);
  const [picked, setPicked] = useState<string>(link.who ?? me.id);
  useEffect(() => {
    if (link.day) setPicked(link.who ?? me.id);
  }, [search]); // only when the link changes

  // Offline (or any failure) keeps whatever list is showing: Me always works.
  const loadFriends = useCallback(() => void listFriends().then(setFriends, () => {}), []);
  useEffect(loadFriends, [loadFriends]);
  useRefreshOnFocus(loadFriends);

  const everyone: Person[] = [
    { id: me.id, me: true, name: "Me", avatar: me.avatar },
    ...friends.map((f) => ({ id: f.id, name: f.displayName, avatar: f.avatar })),
  ];
  const current = picked === EVERYONE && friends.length ? EVERYONE : everyone.find((p) => p.id === picked)?.id ?? me.id;
  const people = current === EVERYONE ? everyone : everyone.filter((p) => p.id === current);

  const choice = (id: string, name: string, face: ReactNode) => (
    <button type="button" key={id} className="who-pick" aria-pressed={current === id} onClick={() => setPicked(id)}>
      {face}
      <span className="who-name">{name}</span>
    </button>
  );

  return (
    <>
      {friends.length > 0 && (
        <div className="who-row" role="group" aria-label="Whose Calendar">
          {everyone.map((p) =>
            choice(p.id, p.name, <span className="avatar" style={{ background: p.avatar.color }} aria-hidden="true">{p.avatar.emoji}</span>),
          )}
          {choice(EVERYONE, "Everyone", (
            <span className="avatar everyone" aria-hidden="true">
              {everyone.slice(0, 4).map((p) => <span key={p.id} style={{ background: p.avatar.color }} />)}
            </span>
          ))}
        </div>
      )}
      <MonthCalendar key={link.day ? search : ""} openDay={link.day} people={people} directory={everyone} combined={current === EVERYONE} viewerZone={me.homeZone} />
    </>
  );
}
