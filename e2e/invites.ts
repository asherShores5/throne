// Invites and Profile setup (ticket 02): a Profile makes an Invite link in Settings; a newcomer opens it,
// creates a Profile with a Display name, Avatar and password (the real pre-sign-up trigger spends the
// Invite), adds a passkey, and the link then stops working. Bad links say to ask for a new Invite.
// Settings edits the Display name, Avatar and Home zone; Invites can be revoked; the 4th is refused.
import { expect } from "playwright/test";
import { TIME_ZONE, launch, type Page } from "./app";
import { db, passkeysOf } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("invites");
const NEW_PASSWORD = "Correct horse 42";

async function settings(user: string, opts = {}) {
  const p = await app.open(user, opts);
  c.watch(p);
  await p.getByRole("link", { name: "Settings" }).click();
  await expect(p.getByRole("heading", { name: "Settings" })).toBeVisible();
  return p;
}

async function makeInvite(p: Page): Promise<string> {
  const before = await p.getByLabel("Invite link").count();
  await p.getByRole("button", { name: "Make an Invite link" }).click();
  await expect(p.getByLabel("Invite link")).toHaveCount(before + 1);
  return p.getByLabel("Invite link").last().inputValue();
}

const pathOf = (link: string) => new URL(link).pathname + new URL(link).hash;
const profileOf = (sub: string) => db.dump().find((r) => r.PK === `PROFILE#${sub}` && r.SK === "PROFILE");

let link = "";

await c.check("Sam makes an Invite link in Settings; it's listed with its expiry", async () => {
  const p = await settings("sam");
  link = await makeInvite(p);
  expect(link).toMatch(/^https:\/\/throne\.test\/invite#[A-Za-z0-9_-]{22}$/);
  const invites = p.getByRole("region", { name: "Invites" });
  await expect(invites.getByRole("listitem")).toHaveCount(1);
  await expect(invites.getByRole("listitem").first()).toContainText("Expires");
  await expect(invites.getByText("doesn't make you Friends")).toBeVisible();
  await shot(p, "phone-settings");
  await p.context().close();
});

await c.check("a newcomer opens the link, sees it doesn't make them Friends, and creates a Profile", async () => {
  const p = await app.open("newbie", { signedOut: true, path: pathOf(link), authenticator: true });
  c.watch(p);
  await expect(p.getByRole("heading", { name: "Join Throne" })).toBeVisible();
  await expect(p.getByText("doesn't make you Friends")).toBeVisible();
  await shot(p, "phone-join");
  await p.getByLabel("Display name").fill("Nina");
  await p.getByRole("radio", { name: "🦊" }).click();
  await p.getByRole("radio", { name: "teal" }).click();
  await p.getByLabel("Username").fill("Nina");
  await p.getByLabel("Password").fill("short");
  await p.getByRole("button", { name: "Create my Profile" }).click();
  await expect(p.getByRole("alert")).toContainText("16");
  await p.getByLabel("Password").fill(NEW_PASSWORD);
  await p.getByRole("button", { name: "Create my Profile" }).click();
  await expect(p.getByText("Welcome, Nina")).toBeVisible();
  expect(profileOf("sub-nina")).toMatchObject({ displayName: "Nina", avatar: { emoji: "🦊", color: "#0c8599" }, homeZone: TIME_ZONE });
  expect(db.dump().find((r) => r.PK.startsWith("INVITE#"))).toMatchObject({ status: "used", usedBy: "nina" });

  // The add-passkey flow, as in HoneyDo: the device's authenticator stands in for Face ID.
  await p.getByRole("button", { name: "Add a passkey" }).click();
  await expect(p.getByText("1 passkey saved")).toBeVisible();
  expect(passkeysOf("nina")).toHaveLength(1);
  await shot(p, "phone-welcome");
  await p.context().close();
});

await c.check("the newcomer signs in again with the password (it stays as the backup)", async () => {
  const p = await app.open("nina", { signedOut: true });
  c.watch(p);
  await p.getByLabel("Username").fill("nina");
  await p.getByRole("button", { name: "Use password instead" }).click();
  await p.getByLabel("Password").fill(NEW_PASSWORD);
  await p.getByRole("button", { name: "Sign in with password" }).click();
  await expect(p.getByText("Hi, Nina.")).toBeVisible();
  await p.context().close();
});

await c.check("the used link now says to ask for a new Invite, and Sam's list is empty", async () => {
  const p = await app.open("x", { signedOut: true, path: pathOf(link) });
  c.watch(p);
  await p.getByLabel("Display name").fill("Late");
  await p.getByLabel("Username").fill("late");
  await p.getByLabel("Password").fill(NEW_PASSWORD);
  await p.getByRole("button", { name: "Create my Profile" }).click();
  await expect(p.getByRole("heading", { name: "This Invite can't be used" })).toBeVisible();
  await expect(p.getByText("Ask for a new Invite")).toBeVisible();
  expect(profileOf("sub-late")).toBeUndefined();
  await p.context().close();
  const sam = await settings("sam");
  await expect(sam.getByRole("region", { name: "Invites" }).getByRole("listitem")).toHaveCount(0);
  await sam.context().close();
});

await c.check("a malformed or missing link says to ask for a new Invite straight away", async () => {
  for (const path of ["/invite#nope", "/invite"]) {
    const p = await app.open("x", { signedOut: true, path });
    c.watch(p);
    await expect(p.getByRole("heading", { name: "This Invite can't be used" })).toBeVisible();
    await expect(p.getByLabel("Password")).toHaveCount(0);
    if (path === "/invite") await shot(p, "phone-bad-invite");
    await p.context().close();
  }
});

await c.check("a revoked Invite's link can't create a Profile", async () => {
  const p = await settings("sam");
  const revoked = await makeInvite(p);
  await p.getByRole("region", { name: "Invites" }).getByRole("button", { name: "Revoke" }).click();
  await expect(p.getByRole("region", { name: "Invites" }).getByRole("listitem")).toHaveCount(0);
  await p.context().close();
  const j = await app.open("x", { signedOut: true, path: pathOf(revoked) });
  c.watch(j);
  await j.getByLabel("Display name").fill("Rev");
  await j.getByLabel("Username").fill("rev");
  await j.getByLabel("Password").fill(NEW_PASSWORD);
  await j.getByRole("button", { name: "Create my Profile" }).click();
  await expect(j.getByRole("heading", { name: "This Invite can't be used" })).toBeVisible();
  await j.context().close();
});

await c.check("a 4th open Invite is refused with a clear message", async () => {
  const p = await settings("alex");
  for (let i = 0; i < 3; i++) await makeInvite(p);
  await p.getByRole("button", { name: "Make an Invite link" }).click();
  await expect(p.getByRole("region", { name: "Invites" }).getByRole("alert")).toContainText("3 open Invites");
  await expect(p.getByRole("region", { name: "Invites" }).getByRole("listitem")).toHaveCount(3);
  await p.context().close();
});

await c.check("Settings edits the Display name and Avatar; Home zone follows the device until overridden", async () => {
  const p = await settings("jo", { dark: true });
  await p.getByLabel("Display name").fill("Jo J");
  await p.getByRole("radio", { name: "🐼" }).click();
  await p.getByRole("radio", { name: "pink" }).click();
  await p.getByRole("button", { name: "Save" }).click();
  await expect(p.getByText("Saved.")).toBeVisible();
  expect(profileOf("sub-jo")).toMatchObject({ displayName: "Jo J", avatar: { emoji: "🐼", color: "#d6336c" } });

  const zone = p.getByRole("region", { name: "Home zone" });
  await expect(zone.getByLabel("Follow this device")).toBeChecked();
  await expect(zone.getByRole("combobox", { name: "Home zone" })).toHaveValue(TIME_ZONE);
  await expect(zone.getByRole("combobox", { name: "Home zone" })).toBeDisabled();
  await zone.getByLabel("Follow this device").uncheck();
  await zone.getByRole("combobox", { name: "Home zone" }).selectOption("Europe/London");
  await expect.poll(() => profileOf("sub-jo")).toMatchObject({ homeZone: "Europe/London", homeZoneAuto: false });
  await shot(p, "phone-settings-dark");
  await p.reload();
  await expect(p.getByRole("region", { name: "Home zone" }).getByRole("combobox", { name: "Home zone" })).toHaveValue("Europe/London");
  await p.getByRole("region", { name: "Home zone" }).getByLabel("Follow this device").check();
  await expect.poll(() => profileOf("sub-jo")).toMatchObject({ homeZone: TIME_ZONE, homeZoneAuto: true });
  await p.context().close();
});

await c.check("desktop: the Invite landing page", async () => {
  const p = await app.open("x", { signedOut: true, device: "desktop", path: "/invite#AAECAwQFBgcICQoLDA0ODw" });
  c.watch(p);
  await expect(p.getByRole("heading", { name: "Join Throne" })).toBeVisible();
  await shot(p, "desktop-join");
  await p.context().close();
});

c.report();
await app.close();
