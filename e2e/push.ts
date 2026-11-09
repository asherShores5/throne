// Push settings (ticket 09): Settings > Notifications shows the defaults (Summary on, the rest off), the
// iPhone hint, the toggles save, Friend logged is picked per Friend and drops out when the Friendship
// ends, and this device turns push on and off (a stand-in push service; nothing is really sent).
// A tapped push's Day link opens the Calendar on that Day. Screenshots: phone, dark phone, desktop.
import { expect } from "playwright/test";
import { TIME_ZONE, launch, type Page } from "./app";
import { db, graphql } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("push");

async function seedProfiles() {
  db.reset();
  for (const [user, name, emoji, color] of [["sam", "Sam", "👑", "#7c5cff"], ["alex", "Alex", "🦆", "#e8590c"]]) {
    await graphql(`fake-id.${user}`, `query { me(homeZone: "${TIME_ZONE}") { id } }`);
    const r = await graphql(`fake-id.${user}`, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name, avatar: { emoji, color } } });
    if (r.errors) throw new Error(JSON.stringify(r.errors));
  }
}

const idOf = async (user: string) => (await graphql(`fake-id.${user}`, `query { me { id } }`)).data.me.id as string;
const prefsOf = async (user: string) => (await graphql(`fake-id.${user}`, `query { pushPrefs { summary friendRequests reactionsComments friendLogged } }`)).data.pushPrefs;
async function befriend(a: string, b: string) {
  const code = (await graphql(`fake-id.${b}`, `query { myFriendCode }`)).data.myFriendCode;
  await graphql(`fake-id.${a}`, `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: code });
  await graphql(`fake-id.${b}`, `mutation A($f: ID!) { acceptFriendRequest(from: $f) { id } }`, { f: await idOf(a) });
}
const devices = () => db.dump().filter((r) => String(r.SK).startsWith("PUSH#"));

async function settings(user: string, opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  const p = await app.open(user, { path: "/settings", ...opts });
  c.watch(p);
  await expect(section(p).getByRole("checkbox").first()).toBeVisible();
  return p;
}
const section = (p: Page) => p.getByRole("region", { name: "Notifications" });
const box = (p: Page, name: string | RegExp) => section(p).getByRole("checkbox", { name });

await seedProfiles();

await c.check("a new Profile: Summary on, Friend requests and Reactions/Comments off, the iPhone hint, no Friends to follow", async () => {
  const p = await settings("sam");
  await expect(box(p, /weekly Summary/)).toBeChecked();
  await expect(box(p, /Friend requests/)).not.toBeChecked();
  await expect(box(p, /Reactions and Comments/)).not.toBeChecked();
  await expect(section(p)).toContainText("Add to Home Screen");
  await expect(section(p)).toContainText("never show Details");
  await expect(section(p)).toContainText("Once you have Friends");
  // Service workers are blocked here, like a Safari tab on iPhone.
  await expect(section(p)).toContainText("This device can't get notifications here.");
  await expect(section(p).getByRole("button", { name: "Turn on notifications" })).toHaveCount(0);
  await shot(p, "phone-settings-notifications");
  await p.context().close();
});

await c.check("toggles save at once and stay after a reload", async () => {
  const p = await settings("sam");
  await box(p, /Friend requests/).check();
  await box(p, /weekly Summary/).uncheck();
  await expect.poll(() => prefsOf("sam")).toMatchObject({ summary: false, friendRequests: true, reactionsComments: false });
  await p.reload();
  await expect(box(p, /Friend requests/)).toBeChecked();
  await expect(box(p, /weekly Summary/)).not.toBeChecked();
  await p.context().close();
});

await c.check("Friend logged is per Friend, and ending the Friendship takes the Friend off", async () => {
  await befriend("sam", "alex");
  const p = await settings("sam");
  await expect(box(p, "Alex")).not.toBeChecked();
  await box(p, "Alex").check();
  await expect.poll(async () => (await prefsOf("sam")).friendLogged).toEqual([await idOf("alex")]);
  expect((await prefsOf("alex")).friendLogged).toEqual([]);
  await graphql("fake-id.alex", `mutation E($f: ID!) { endFriendship(friend: $f) }`, { f: await idOf("sam") });
  await p.reload();
  await expect(section(p)).toContainText("Once you have Friends");
  expect((await prefsOf("sam")).friendLogged).toEqual([]);
  await p.context().close();
});

await c.check("this device turns push on (saved on the server) and off again", async () => {
  const p = await settings("sam", { serviceWorkers: true, fakePush: true });
  await expect(section(p).getByRole("status")).toHaveText("Off on this device.");
  await section(p).getByRole("button", { name: "Turn on notifications" }).click();
  await expect(section(p).getByRole("status")).toHaveText("On for this device.");
  expect(devices()).toHaveLength(1);
  expect(String(devices()[0].endpoint)).toMatch(/^https:\/\/fcm\.googleapis\.com\/fcm\/send\/e2e-/);
  await p.reload();
  await expect(section(p).getByRole("status")).toHaveText("On for this device.");
  await shot(p, "phone-settings-push-on");
  await section(p).getByRole("button", { name: "Turn off on this device" }).click();
  await expect(section(p).getByRole("status")).toHaveText("Off on this device.");
  expect(devices()).toHaveLength(0);
  await p.context().close();
});

await c.check("signing out releases this device's push", async () => {
  const p = await settings("sam", { serviceWorkers: true, fakePush: true });
  await section(p).getByRole("button", { name: "Turn on notifications" }).click();
  await expect(section(p).getByRole("status")).toHaveText("On for this device.");
  expect(devices()).toHaveLength(1);
  await p.getByRole("link", { name: /Throne/ }).click();
  await p.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => devices().length).toBe(0);
  await p.context().close();
});

await c.check("a Friend logged push's link opens that Friend's Calendar on the Day", async () => {
  await befriend("sam", "alex");
  const day = new Date().toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
  await graphql("fake-id.alex", `mutation L($l: NewLog!) { createLog(log: $l) { id } }`, { l: { id: "00000000-0000-4000-8000-000000000001" } });
  const p = await app.open("sam", { path: `/calendar?who=${await idOf("alex")}&day=${day}` });
  c.watch(p);
  await expect(p.getByRole("button", { name: "Alex" })).toHaveAttribute("aria-pressed", "true");
  const sheet = p.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Alex's Logs");
  await shot(p, "phone-push-day-link");
  await p.context().close();
});

await c.check("screenshots: dark phone and desktop", async () => {
  const dark = await settings("sam", { dark: true });
  await shot(dark, "phone-settings-notifications-dark");
  await dark.context().close();
  const desk = await settings("sam", { device: "desktop" });
  await shot(desk, "desktop-settings-notifications");
  await desk.context().close();
});

c.report();
await app.close();
