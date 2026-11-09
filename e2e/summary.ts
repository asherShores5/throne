// Weekly Summary (ticket 10): after the hourly run at Monday 08:00 (Los Angeles), Home shows the latest
// Summary as a card, and /summary (where a Summary push lands) shows it in full, then past weeks newest
// first. Before the first one, both say when it comes. Screenshots: phone, dark phone, desktop.
import { randomUUID } from "node:crypto";
import { expect } from "playwright/test";
import { TIME_ZONE, launch, type Page } from "./app";
import { db, graphql, runSchedule, setServerClock, USERS } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("summary");

// Monday 16 November 2026, 09:00 in Los Angeles: Summaries for Nov 2-8 and Nov 9-15 exist.
const CLOCK = "2026-11-16T17:00:00Z";

async function gq(user: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await graphql(`fake-id.${user}`, query, variables);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
}

async function seed(user: string, instant: string, details: Record<string, unknown> = {}) {
  setServerClock(instant);
  await gq(user, `mutation C($log: NewLog!) { createLog(log: $log) { id } }`, { log: { id: randomUUID(), instant, ...details } });
}

async function befriend(a: string, b: string) {
  const { myFriendCode } = await gq(b, `query { myFriendCode }`);
  await gq(a, `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: myFriendCode });
  await gq(b, `mutation A($f: ID!) { acceptFriendRequest(from: $f) { id } }`, { f: USERS[a].sub });
}

/** Sam and Alex (both LA, Friends). Sam logs 06:00 every Day of Nov 9-15; Alex 21:00 on three Days. */
async function seedAll({ summaries = true } = {}) {
  db.reset();
  setServerClock("2026-11-01T18:00:00Z");
  for (const [user, name, emoji, color] of [["sam", "Sam", "👑", "#7c5cff"], ["alex", "Alex", "🦆", "#e8590c"]]) {
    await gq(user, `query { me(homeZone: "${TIME_ZONE}") { id } }`);
    await gq(user, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name, avatar: { emoji, color } } });
  }
  await befriend("sam", "alex");
  await seed("sam", "2026-11-04T14:00:00Z");
  for (let d = 9; d <= 15; d++) await seed("sam", `2026-11-${String(d).padStart(2, "0")}T14:00:00Z`, d === 10 ? { bristolType: 4 } : {});
  for (const d of [10, 11, 12]) await seed("alex", `2026-11-${d}T05:00:00Z`); // 21:00 the Day before in LA
  if (summaries) {
    await runSchedule("2026-11-09T16:00:00Z");
    await runSchedule("2026-11-16T16:00:00Z");
  }
  setServerClock(CLOCK);
}

async function open(path = "/", opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  setServerClock(CLOCK);
  const p = await app.open("sam", { clock: CLOCK, path, ...opts });
  c.watch(p);
  return p;
}

await c.check("before the first Summary: Home and /summary say when it comes", async () => {
  await seedAll({ summaries: false });
  const p = await open();
  await expect(p.getByText("Your first Summary comes on Monday morning.")).toBeVisible();
  await p.goto(p.url().replace(/\/$/, "") + "/summary");
  await expect(p.getByText("Your first Summary comes on Monday morning.")).toBeVisible();
  await p.context().close();
});

await c.check("Home shows the latest Summary as a card: each person's total, Awards, a link to the rest", async () => {
  await seedAll();
  const p = await open();
  const card = p.getByRole("region", { name: /^Summary for Nov 9/ });
  await expect(card.getByRole("heading", { name: "Latest Summary" })).toBeVisible();
  await expect(card.locator(".summary-person .name")).toHaveText(["Sam (you)", "Alex"]);
  await expect(card.locator(".summary-total")).toHaveText(["7", "3"]);
  await expect(card.getByRole("list", { name: "Awards" })).toContainText("Early bird: You");
  await expect(card.getByRole("list", { name: "Awards" })).toContainText("Night owl: Alex");
  await expect(card.getByRole("list", { name: "Awards" })).toContainText("Streak: You");
  await shot(p, "phone-home-summary");
  await p.getByRole("link", { name: /See the full Summary/ }).click();
  await expect(p.getByRole("heading", { name: "Summary", level: 1 })).toBeVisible();
  await p.context().close();
});

await c.check("/summary: the latest in full (average, change, Bristol type), then past weeks newest first", async () => {
  await seedAll();
  const p = await open("/summary");
  const cards = p.locator("section.summary");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAccessibleName(/^Summary for Nov 9/);
  await expect(cards.nth(1)).toHaveAccessibleName(/^Summary for Nov 2/);
  const sam = cards.nth(0).locator(".summary-person").first();
  await expect(sam).toContainText("1 a Day");
  await expect(sam).toContainText("▲ 6 vs the week before");
  await expect(sam).toContainText("Mostly type 4 (Smooth)");
  await expect(p.getByRole("heading", { name: "Past Summaries" })).toBeVisible();
  // Nov 2-8: Sam 1, Alex 0, nobody had enough data for an Award.
  await expect(cards.nth(1).locator(".summary-total")).toHaveText(["1", "0"]);
  await expect(cards.nth(1).getByRole("list", { name: "Awards" })).toHaveCount(0);
  await shot(p, "phone-summary");
  await p.context().close();
  const dark = await open("/summary", { dark: true });
  await expect(dark.locator("section.summary")).toHaveCount(2);
  await shot(dark, "phone-summary-dark");
  await dark.context().close();
  const desk = await open("/summary", { device: "desktop" });
  await expect(desk.locator("section.summary")).toHaveCount(2);
  await shot(desk, "desktop-summary");
  await desk.context().close();
});

c.report();
await app.close();
