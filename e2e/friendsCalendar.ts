// Friends on the Calendar (ticket 07): the Avatar row (Me, each Friend, Everyone) appears once I have a
// Friend; a Friend's Calendar shows their Logs on their own Days (their Log zone) with full Details,
// read-only; Everyone is the combined grid (a small count per person in Avatar colors, a clashing color
// gets another shade plus the emoji), one range query per person; ending a Friendship removes them at
// once; and my own Calendar shows Logs still waiting to sync. Screenshots: phone, dark phone, desktop.
import { randomUUID } from "node:crypto";
import { expect } from "playwright/test";
import { TIME_ZONE, launch, setOffline, type Page } from "./app";
import { USERS, calls, db, graphql, setServerClock } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("friends-calendar");

// Sunday 8 November 2026, 10:00 in Los Angeles (the page's zone).
const CLOCK = "2026-11-08T18:00:00Z";

async function gq(user: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await graphql(`fake-id.${user}`, query, variables);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
}

/** A Log for `user` made at `instant` (server clock moved there, so the time rules pass). */
async function seed(user: string, instant: string, details: Record<string, unknown> = {}) {
  setServerClock(instant);
  await gq(user, `mutation C($log: NewLog!) { createLog(log: $log) { id } }`, { log: { id: randomUUID(), instant, ...details } });
}

async function befriend(a: string, b: string) {
  const { myFriendCode } = await gq(b, `query { myFriendCode }`);
  await gq(a, `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: myFriendCode });
  await gq(b, `mutation A($f: ID!) { acceptFriendRequest(from: $f) { id } }`, { f: USERS[a].sub });
}

/**
 * Sam (LA, 👑 purple), Alex (LA, 🦆 orange), Jo (LA, 🐸 purple like Sam: a clash), Max (Tokyo, 🦊 blue).
 * Logs (LA Days unless noted): Sam Nov 2 one, Nov 6 two. Alex Nov 3 one, Nov 6 three (one at 07:00 with
 * Details). Jo Nov 6 one. Max one at 2026-11-07T20:00Z = 05:00 on Nov 8 in Tokyo (still Nov 7 in LA).
 */
async function seedAll({ friends = true } = {}) {
  db.reset();
  const people: [string, string, string, string, string][] = [
    ["sam", "Sam", "👑", "#7c5cff", TIME_ZONE], ["alex", "Alex", "🦆", "#e8590c", TIME_ZONE],
    ["jo", "Jo", "🐸", "#7c5cff", TIME_ZONE], ["max", "Max", "🦊", "#1c7ed6", "Asia/Tokyo"],
  ];
  for (const [user, name, emoji, color, zone] of people) {
    await gq(user, `query { me(homeZone: "${zone}") { id } }`);
    await gq(user, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name, avatar: { emoji, color } } });
  }
  await seed("sam", "2026-11-02T16:00:00Z");
  for (const h of [15, 20]) await seed("sam", `2026-11-06T${h}:00:00Z`);
  await seed("alex", "2026-11-03T16:00:00Z");
  await seed("alex", "2026-11-06T15:00:00Z", { duration: 9, bristolType: 4, note: "big one", flags: ["urgent"] });
  for (const h of [18, 21]) await seed("alex", `2026-11-06T${h}:00:00Z`);
  await seed("jo", "2026-11-06T17:00:00Z");
  await seed("max", "2026-11-07T20:00:00Z");
  setServerClock(CLOCK);
  // Friends list order (oldest Friendship first): Alex, Jo, Max.
  if (friends) for (const f of ["alex", "jo", "max"]) await befriend("sam", f);
}

async function calendar(user = "sam", opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  setServerClock(CLOCK);
  const p = await app.open(user, { clock: CLOCK, ...opts });
  c.watch(p);
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Calendar" }).click();
  await expect(p.getByRole("heading", { name: "November 2026" })).toBeVisible();
  return p;
}

const row = (p: Page) => p.getByRole("group", { name: "Whose Calendar" });
const pick = (p: Page, name: string) => row(p).getByRole("button", { name });
const cell = (p: Page, day: string) => p.locator(`[data-day="${day}"]`);
const mini = (p: Page, day: string, user: string) => cell(p, day).locator(`.mini[data-person="${USERS[user].sub}"]`);

await c.check("no Friends: no Avatar row, just my Calendar", async () => {
  await seedAll({ friends: false });
  const p = await calendar();
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("2");
  await expect(row(p)).toHaveCount(0);
  await p.context().close();
});

await c.check("the Avatar row lists Me, each Friend in Friends-list order, and Everyone; Me is picked", async () => {
  await seedAll();
  const p = await calendar();
  await expect(row(p).locator(".who-name")).toHaveText(["Me", "Alex", "Jo", "Max", "Everyone"]);
  await expect(pick(p, "Me")).toHaveAttribute("aria-pressed", "true");
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("2");
  await shot(p, "phone-calendar-row");
  await p.context().close();
});

await c.check("Alex's Calendar: Alex's counts, totals, and a read-only Day sheet with full Details", async () => {
  await seedAll();
  const p = await calendar();
  await pick(p, "Alex").click();
  await expect(pick(p, "Alex")).toHaveAttribute("aria-pressed", "true");
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("3");
  await expect(cell(p, "2026-11-03").locator(".count")).toHaveText("1");
  await expect(cell(p, "2026-11-02").locator(".count")).toHaveText("");
  await expect(p.getByRole("region", { name: "Month totals" })).toContainText("4 Logs");
  await cell(p, "2026-11-06").click();
  const sheet = p.getByRole("dialog");
  await expect(sheet).toContainText("Alex's Logs");
  await expect(sheet.getByRole("listitem")).toHaveCount(3);
  const item = sheet.getByRole("listitem", { name: "Log at 07:00" });
  for (const t of ["4 Smooth", "9 min", "Urgent", "big one"]) await expect(item).toContainText(t);
  await expect(sheet.getByRole("button", { name: /^(Edit|Delete) Log/ })).toHaveCount(0);
  await shot(p, "phone-friend-day-sheet");
  await p.context().close();
});

await c.check("Max's Calendar uses Max's Days (Tokyo): the Log sits on Nov 8 at 05:00, not Nov 7", async () => {
  await seedAll();
  const p = await calendar();
  await pick(p, "Max").click();
  await expect(cell(p, "2026-11-08").locator(".count")).toHaveText("1");
  await expect(cell(p, "2026-11-07").locator(".count")).toHaveText("");
  await cell(p, "2026-11-08").click();
  await expect(p.getByRole("dialog").getByRole("listitem", { name: "Log at 05:00" })).toBeVisible();
  await p.context().close();
});

await c.check("a Friend's past months are there too (no history limit)", async () => {
  await seedAll();
  setServerClock("2026-10-15T18:00:00Z");
  await gq("alex", `mutation C($log: NewLog!) { createLog(log: $log) { id } }`, { log: { id: randomUUID(), instant: "2026-10-15T18:00:00Z" } });
  const p = await calendar();
  await pick(p, "Alex").click();
  await p.getByRole("button", { name: "Previous month" }).click();
  await expect(cell(p, "2026-10-15").locator(".count")).toHaveText("1");
  await p.context().close();
});

await c.check("Everyone: a small count per person per Day in Avatar colors, one range query per person", async () => {
  await seedAll();
  const p = await calendar();
  const before = calls.length;
  await pick(p, "Everyone").click();
  await expect(mini(p, "2026-11-06", "alex")).toHaveText("3");
  await expect(mini(p, "2026-11-06", "sam")).toHaveText("2");
  await expect(mini(p, "2026-11-06", "jo")).toContainText("1");
  await expect(mini(p, "2026-11-06", "max")).toHaveText("");
  await expect(mini(p, "2026-11-08", "max")).toHaveText("1");
  await expect(cell(p, "2026-11-06").getByRole("button")).toHaveAccessibleName(/Me 2, Alex 3, Jo 1, Max 0$/);
  const bg = (user: string) => mini(p, "2026-11-06", user).evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await bg("sam")).toBe("rgb(124, 92, 255)");
  expect(await bg("alex")).toBe("rgb(232, 89, 12)");
  // Jo picked Sam's purple: Jo (later in the list) gets another shade plus the 🐸.
  expect(await bg("jo")).not.toBe(await bg("sam"));
  await expect(mini(p, "2026-11-06", "jo")).toContainText("🐸");
  await expect(mini(p, "2026-11-06", "sam")).not.toContainText("👑");
  // Each load of the month asks once per person (4): myLogs for me, friendLogs for each Friend.
  const asked = calls.slice(before).filter((x) => x.field === "myLogs" || x.field === "friendLogs");
  const distinct = [...new Set(asked.map((x) => JSON.stringify([x.field, x.args])))].sort();
  expect(distinct).toEqual([
    JSON.stringify(["friendLogs", { friend: USERS.alex.sub, from: "2026-11-01", to: "2026-11-30" }]),
    JSON.stringify(["friendLogs", { friend: USERS.jo.sub, from: "2026-11-01", to: "2026-11-30" }]),
    JSON.stringify(["friendLogs", { friend: USERS.max.sub, from: "2026-11-01", to: "2026-11-30" }]),
    JSON.stringify(["myLogs", { from: "2026-11-01", to: "2026-11-30" }]),
  ]);
  const legend = p.getByRole("region", { name: "Month totals" });
  await expect(legend.getByRole("listitem", { name: "Me: 3 Logs, 0.4 a Day" })).toBeVisible();
  await expect(legend.getByRole("listitem", { name: /^Alex: 4 Logs/ })).toBeVisible();
  await shot(p, "phone-calendar-everyone");
  await p.context().close();
});

await c.check("Everyone's Day sheet groups Logs by person; only mine can be edited or deleted", async () => {
  await seedAll();
  const p = await calendar();
  await pick(p, "Everyone").click();
  await expect(mini(p, "2026-11-06", "alex")).toHaveText("3");
  await cell(p, "2026-11-06").click();
  const sheet = p.getByRole("dialog");
  await expect(sheet.getByRole("region", { name: "My Logs" }).getByRole("listitem")).toHaveCount(2);
  await expect(sheet.getByRole("region", { name: "Alex's Logs" }).getByRole("listitem")).toHaveCount(3);
  await expect(sheet.getByRole("region", { name: "Jo's Logs" }).getByRole("listitem")).toHaveCount(1);
  await expect(sheet.getByRole("region", { name: "Max's Logs" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /^Delete Log/ })).toHaveCount(2);
  await expect(sheet.getByRole("region", { name: "Alex's Logs" }).getByRole("button", { name: /^(Edit|Delete) Log/ })).toHaveCount(0);
  await shot(p, "phone-everyone-day-sheet");
  await p.context().close();
});

await c.check("ending a Friendship removes access at once: they leave the row and the API says not found", async () => {
  await seedAll();
  const p = await calendar();
  await pick(p, "Alex").click();
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("3");
  await gq("alex", `mutation E($f: ID!) { endFriendship(friend: $f) }`, { f: USERS.sam.sub });
  const r = await graphql("fake-id.sam", `query Q($f: ID!) { friendLogs(friend: $f, from: "2026-11-01", to: "2026-11-30") { id } }`, { f: USERS.alex.sub });
  expect(r.errors?.[0]?.message).toBe("NotFound: No such Friend.");
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row(p).locator(".who-name")).toHaveText(["Me", "Jo", "Max", "Everyone"]);
  await expect(pick(p, "Me")).toHaveAttribute("aria-pressed", "true");
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("2");
  await p.context().close();
});

await c.check("my Calendar shows a Log made offline, marked waiting to sync", async () => {
  await seedAll();
  setServerClock(CLOCK);
  const p = await app.open("sam", { clock: CLOCK });
  c.watch(p);
  await expect(p.getByRole("region", { name: "Recent Logs" }).getByRole("listitem").first()).toBeVisible();
  await setOffline(p, true);
  await p.getByRole("button", { name: "Log now" }).click();
  await expect(p.getByRole("status")).toContainText("Logged at");
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Calendar" }).click();
  await expect(cell(p, "2026-11-08").locator(".count")).toHaveText("1");
  await cell(p, "2026-11-08").click();
  await expect(p.getByRole("dialog").getByText("Waiting to sync")).toBeVisible();
  await p.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await setOffline(p, false);
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await gq("sam", `query { myLogs(from: "2026-11-08", to: "2026-11-08") { id } }`)).myLogs.length).toBe(1);
  await cell(p, "2026-11-08").click();
  await expect(p.getByRole("dialog").getByRole("listitem")).toHaveCount(1);
  await expect(p.getByRole("dialog").getByText("Waiting to sync")).toHaveCount(0);
  await p.context().close();
});

await c.check("screenshots: dark phone and desktop, Friend view and Everyone", async () => {
  await seedAll();
  const dark = await calendar("sam", { dark: true });
  await pick(dark, "Everyone").click();
  await expect(mini(dark, "2026-11-06", "alex")).toHaveText("3");
  await shot(dark, "phone-calendar-everyone-dark");
  await pick(dark, "Alex").click();
  await expect(cell(dark, "2026-11-06").locator(".count")).toHaveText("3");
  await shot(dark, "phone-calendar-friend-dark");
  await dark.context().close();
  const desk = await calendar("sam", { device: "desktop" });
  await pick(desk, "Everyone").click();
  await expect(mini(desk, "2026-11-06", "alex")).toHaveText("3");
  await shot(desk, "desktop-calendar-everyone");
  await desk.context().close();
});

c.report();
await app.close();
