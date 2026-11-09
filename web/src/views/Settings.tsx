import { useEffect, useMemo, useState } from "react";
import { DISPLAY_NAME_MAX, cleanDisplayName, type Avatar } from "@throne/shared";
import { listPasskeys, registerPasskey } from "../auth";
import { createInvite, linkFor, listInvites, revokeInvite, type Invite } from "../api/invite";
import { deviceZone, loadMe, plainMessage, updateProfile, type Profile } from "../api/profile";
import { onLink } from "../route";
import { AvatarPicker } from "./AvatarPicker";

/** Settings (/settings): the Profile's Display name, Avatar and Home zone, passkeys, and Invites. */
export function Settings() {
  const [me, setMe] = useState<Profile>();
  const [error, setError] = useState<string>();
  const welcome = useMemo(() => new URLSearchParams(location.search).has("welcome"), []);

  useEffect(() => {
    loadMe().then(setMe, (e) => setError(plainMessage(e)));
  }, []);

  return (
    <main className="settings">
      <header className="topbar">
        <a className="link" href="/" onClick={onLink("/")}>‹ Throne</a>
        <h1>Settings</h1>
        <span className="topbar-spacer" />
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!me ? (
        !error && <p className="center">Loading…</p>
      ) : (
        <>
          {welcome && (
            <section className="card welcome" aria-label="Welcome">
              <p><strong>Welcome, {me.displayName}.</strong> Add a passkey below so you can sign in with Face ID. Your password stays as the backup.</p>
            </section>
          )}
          <ProfileSection me={me} onSaved={setMe} />
          <HomeZoneSection me={me} onSaved={setMe} />
          <PasskeySection />
          <InviteSection />
        </>
      )}
    </main>
  );
}

function ProfileSection({ me, onSaved }: { me: Profile; onSaved: (p: Profile) => void }) {
  const [name, setName] = useState(me.displayName);
  const [avatar, setAvatar] = useState<Avatar>(me.avatar);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const displayName = cleanDisplayName(name);
    if (!displayName) return setStatus({ ok: false, text: `A Display name is 1 to ${DISPLAY_NAME_MAX} characters.` });
    setBusy(true);
    try {
      onSaved(await updateProfile({ displayName, avatar }));
      setStatus({ ok: true, text: "Saved." });
    } catch (err) {
      setStatus({ ok: false, text: plainMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" aria-label="Profile" onSubmit={save}>
      <h2>Profile</h2>
      <label>
        Display name
        <input value={name} maxLength={48} onChange={(e) => { setName(e.target.value); setStatus(undefined); }} autoComplete="nickname" />
      </label>
      <span className="hint">Your Friends see your Display name and Avatar.</span>
      <AvatarPicker value={avatar} onChange={(a) => { setAvatar(a); setStatus(undefined); }} />
      <button className="primary" disabled={busy}>Save</button>
      {status && <p className={status.ok ? "hint" : "error"} role={status.ok ? "status" : "alert"}>{status.text}</p>}
    </form>
  );
}

/** Every IANA zone the browser knows, plus the current one (UTC may not be listed). */
function zoneChoices(current: string) {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) ? all : [current, ...all];
}

function HomeZoneSection({ me, onSaved }: { me: Profile; onSaved: (p: Profile) => void }) {
  const [error, setError] = useState<string>();
  const zones = useMemo(() => zoneChoices(me.homeZone), [me.homeZone]);

  async function save(edit: { homeZone: string; homeZoneAuto: boolean }) {
    setError(undefined);
    try {
      onSaved(await updateProfile(edit));
    } catch (err) {
      setError(plainMessage(err));
    }
  }

  return (
    <section className="card" aria-label="Home zone">
      <h2>Home zone</h2>
      <label className="check">
        <input type="checkbox" checked={me.homeZoneAuto}
          onChange={(e) => void save({ homeZone: e.target.checked ? deviceZone() : me.homeZone, homeZoneAuto: e.target.checked })} />
        Follow this device
      </label>
      <label>
        Home zone
        <select value={me.homeZone} disabled={me.homeZoneAuto} onChange={(e) => void save({ homeZone: e.target.value, homeZoneAuto: false })}>
          {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <span className="hint">New Logs count on their Day in this zone.</span>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function PasskeySection() {
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listPasskeys().then((p) => setCount(p.length), () => {});
  }, []);

  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      await registerPasskey();
      setCount((await listPasskeys()).length);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Passkeys">
      <h2>Passkeys</h2>
      <p className="hint">
        {count === undefined ? "Sign in with Face ID (or your computer's passkey)." : `${count} passkey${count === 1 ? "" : "s"} saved.`}{" "}
        Your password always works too.
      </p>
      <button type="button" disabled={busy} onClick={() => void add()}>Add a passkey</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

const expiry = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function InviteSection() {
  const [invites, setInvites] = useState<Invite[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string>();

  useEffect(() => {
    listInvites().then(setInvites, (e) => setError(plainMessage(e)));
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(plainMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const make = () => run(async () => {
    const inv = await createInvite();
    setInvites((l) => [...(l ?? []), inv]);
  });
  const revoke = (token: string) => run(async () => {
    await revokeInvite(token);
    setInvites((l) => (l ?? []).filter((i) => i.token !== token));
  });

  async function share(inv: Invite) {
    const url = linkFor(inv);
    if (navigator.share) {
      await navigator.share({ title: "Join me on Throne", url }).catch(() => {});
      return;
    }
    await navigator.clipboard?.writeText(url).then(() => setCopied(inv.token), () => {});
  }

  return (
    <section className="card" aria-label="Invites">
      <h2>Invites</h2>
      <p className="hint">
        An Invite link lets one person make a Profile. It lasts 7 days, works once, and doesn't make you Friends.
        You can have 3 open at a time.
      </p>
      {invites && invites.length > 0 && (
        <ul className="invites">
          {invites.map((inv) => (
            <li key={inv.token}>
              <input readOnly aria-label="Invite link" value={linkFor(inv)} onFocus={(e) => e.target.select()} />
              <div className="invite-row">
                <span className="hint">Expires {expiry(inv.expiresAt)}</span>
                <span>
                  <button type="button" className="link" onClick={() => void share(inv)}>{copied === inv.token ? "Copied" : "Share link"}</button>
                  {" · "}
                  <button type="button" className="link danger" disabled={busy} onClick={() => void revoke(inv.token)}>Revoke</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy || !invites} onClick={() => void make()}>Make an Invite link</button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
