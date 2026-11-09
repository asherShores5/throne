// Settings > Notifications (ticket 09): turn push on for this device, and pick which pushes come (per
// Profile, so every device gets the same ones). Online only. Browser glue: notifications.ts.
import { useCallback, useEffect, useState } from "react";
import type { PushPrefs } from "@throne/shared";
import { listFriends, type Friend } from "../api/friend";
import { loadPushPrefs, updatePushPrefs } from "../api/push";
import { currentNotificationState, disableNotifications, enableNotifications, resaveSubscription } from "../notifications";
import type { NotificationState } from "../push";
import { plainMessage } from "../api/profile";

const TOGGLES: { key: "summary" | "friendRequests" | "reactionsComments"; label: string }[] = [
  { key: "summary", label: "My weekly Summary (Monday morning)" },
  { key: "friendRequests", label: "Friend requests, and when one I sent is accepted" },
  { key: "reactionsComments", label: "Reactions and Comments on my Logs" },
];

export function NotificationsSection() {
  const [prefs, setPrefs] = useState<PushPrefs>();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    loadPushPrefs().then(setPrefs, (e) => setError(plainMessage(e)));
    listFriends().then(setFriends, () => {});
  }, []);

  // Shown at once (a controlled checkbox would snap back until the save answers); undone if it fails.
  async function save(edit: Partial<PushPrefs>) {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, ...edit });
    setError(undefined);
    try {
      setPrefs(await updatePushPrefs(edit));
    } catch (e) {
      setPrefs(before);
      setError(plainMessage(e));
    }
  }

  const follow = (id: string, on: boolean) =>
    prefs && void save({ friendLogged: on ? [...new Set([...prefs.friendLogged, id])] : prefs.friendLogged.filter((f) => f !== id) });

  return (
    <section className="card" aria-label="Notifications">
      <h2>Notifications</h2>
      <DeviceRow />
      <p className="hint">
        On iPhone, notifications only work in the installed app: in Safari tap Share, then Add to Home Screen, and open
        Throne from your Home Screen. Then turn them on here.
      </p>
      {prefs && (
        <>
          <fieldset className="checks">
            <legend>Send me</legend>
            {TOGGLES.map((t) => (
              <label className="check" key={t.key}>
                <input type="checkbox" checked={prefs[t.key]} onChange={(e) => void save({ [t.key]: e.target.checked })} />
                {t.label}
              </label>
            ))}
          </fieldset>
          <fieldset className="checks">
            <legend>When a Friend logs</legend>
            {friends.length === 0 && <span className="hint">Once you have Friends, pick whose Logs notify you.</span>}
            {friends.map((f) => (
              <label className="check" key={f.id}>
                <input type="checkbox" checked={prefs.friendLogged.includes(f.id)} onChange={(e) => follow(f.id, e.target.checked)} />
                <span className="avatar small" style={{ background: f.avatar.color }} aria-hidden="true">{f.avatar.emoji}</span>
                {f.displayName}
              </label>
            ))}
          </fieldset>
        </>
      )}
      <span className="hint">Notifications never show Details, just who did what (like "Sam logged").</span>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

const STATE_TEXT: Record<NotificationState, string> = {
  unsupported: "This device can't get notifications here.",
  blocked: "Notifications are blocked for Throne. Allow them in your phone's Settings, then come back.",
  off: "Off on this device.",
  unsaved: "Almost on: this device still needs to be saved.",
  on: "On for this device.",
};

/** This device: on, off, or why it can't. The permission prompt runs inside the button's click handler. */
function DeviceRow() {
  const [state, setState] = useState<NotificationState>();
  const [reg, setReg] = useState<ServiceWorkerRegistration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    currentNotificationState().then(({ state, reg }) => {
      setState(state);
      setReg(reg);
    }, () => setState("unsupported"));
  }, []);
  useEffect(refresh, [refresh]);

  function run(p: Promise<void>) {
    setBusy(true);
    setError(undefined);
    p.catch((e) => setError(plainMessage(e))).finally(() => {
      setBusy(false);
      refresh();
    });
  }

  if (!state) return <p className="hint">Checking this device…</p>;
  return (
    <div className="device-row">
      <p role="status">{STATE_TEXT[state]}</p>
      {reg && state === "off" && (
        // No awaits before enableNotifications: iOS only prompts during the tap itself.
        <button type="button" className="primary" disabled={busy} onClick={() => run(enableNotifications(reg))}>Turn on notifications</button>
      )}
      {reg && state === "unsaved" && <button type="button" disabled={busy} onClick={() => run(resaveSubscription(reg))}>Finish turning on</button>}
      {reg && (state === "on" || state === "unsaved") && (
        <button type="button" className="link" disabled={busy} onClick={() => run(disableNotifications(reg))}>Turn off on this device</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
