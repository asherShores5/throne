// Reactions and Comments (ticket 08): on a Friend's Log in the Day sheet a Profile picks one of 6 emoji
// (tap again to take it off) and writes Comments; the owner sees everyone's on the Log tab and in the Day
// sheet and can delete any Comment; a Friend sees only their own (Sam is Friends with Alex and Jo, who
// aren't Friends with each other); a Day with some shows a marker; deleting the Log takes them with it.
// Screenshots: phone, dark phone.
import { randomUUID } from "node:crypto";
import { expect } from "playwright/test";
import { launch, type Page } from "./app";
import { USERS, db, graphql, setServerClock } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("reactions");

// Sunday 8 November 2026, 10:00 in Los Angeles (the page's zone).
const CLOCK = "2026-11-08T18:00:00Z";
const DAY = "2026-11-06";
const LOG_ID = randomUUID();

async function gq(user: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await graphql(`fake-id.${user}`, query, variables);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
}

async function befriend(a: string, b: string) {
  const { myFriendCode } = await gq(b, `query { myFriendCode }`);
  await gq(a, `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: myFriendCode });
  await gq(b, `mutation A($f: ID!) { acceptFriendRequest(from: $f) { id } }`, { f: USERS[a].sub });
}

/** Sam (Friends with Alex and Jo), Alex, Jo. Sam has one Log on Nov 6 at 07:00 (LA). */
async function seedAll() {
  db.reset();
  for (const [user, name, emoji, color] of [["sam", "Sam", "👑", "#7c5cff"], ["alex", "Alex", "🦆", "#e8590c"], ["jo", "Jo", "🐸", "#2b8a3e"]]) {
    await gq(user, `query { me(homeZone: "America/Los_Angeles") { id } }`);
    await gq(user, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name, avatar: { emoji, color } } });
  }
  setServerClock("2026-11-06T15:00:00Z");
  await gq("sam", `mutation C($log: NewLog!) { createLog(log: $log) { id } }`, { log: { id: LOG_ID, instant: "2026-11-06T15:00:00Z", bristolType: 4 } });
  setServerClock(CLOCK);
  await befriend("sam", "alex");
  await befriend("sam", "jo");
}

const sam = USERS.sam.sub;
const react = (user: string, emoji: string | null) =>
  gq(user, `mutation R($o: ID!, $l: ID!, $e: String) { setReaction(owner: $o, log: $l, emoji: $e) { id } }`, { o: sam, l: LOG_ID, e: emoji });
const comment = (user: string, text: string) =>
  gq(user, `mutation M($o: ID!, $l: ID!, $i: ID!, $t: String!) { addComment(owner: $o, log: $l, id: $i, text: $t) { id } }`, { o: sam, l: LOG_ID, i: randomUUID(), t: text });

async function open(user: string, opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  setServerClock(CLOCK);
  const p = await app.open(user, { clock: CLOCK, ...opts });
  c.watch(p);
  return p;
}

async function samsDaySheet(p: Page) {
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Calendar" }).click();
  await expect(p.getByRole("heading", { name: "November 2026" })).toBeVisible();
  await p.getByRole("group", { name: "Whose Calendar" }).getByRole("button", { name: "Sam" }).click();
  await expect(p.locator(`[data-day="${DAY}"] .count`)).toHaveText("1");
  await p.locator(`[data-day="${DAY}"]`).click();
  return p.getByRole("dialog");
}

const marker = (p: Page) => p.locator(`[data-day="${DAY}"] .marker`);
const responsesLeft = () => db.dump().filter((r) => String(r.SK).startsWith("RESPFROM#") || r.reactions || r.comments);

await c.check("Alex reacts and comments on Sam's Log in the Day sheet; the Day gets a marker", async () => {
  await seedAll();
  const p = await open("alex");
  const sheet = await samsDaySheet(p);
  await expect(marker(p)).toHaveCount(0);
  const bar = sheet.getByRole("group", { name: "React" });
  await expect(bar.getByRole("button", { name: /^React / })).toHaveCount(6);
  await bar.getByRole("button", { name: "React 👏" }).click();
  await expect(bar.getByRole("button", { name: "React 👏" })).toHaveAttribute("aria-pressed", "true");
  // Change it: only one per person.
  await bar.getByRole("button", { name: "React 😂" }).click();
  await expect(bar.getByRole("button", { name: "React 😂" })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("button", { name: "React 👏" })).toHaveAttribute("aria-pressed", "false");
  await sheet.getByRole("button", { name: "Comment", exact: true }).click();
  await sheet.getByRole("textbox", { name: "Comment" }).fill("Nice one");
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect(sheet.getByRole("list", { name: "Comments" })).toContainText("You Nice one");
  await shot(p, "phone-reactions-friend-sheet");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(marker(p)).toHaveCount(1);
  await expect(p.locator(`[data-day="${DAY}"] button`)).toHaveAttribute("aria-label", /with Reactions or Comments/);
  await p.context().close();
});

await c.check("Jo's Reaction and Comment are invisible to Alex (they aren't Friends); Alex sees only their own", async () => {
  await react("jo", "💩");
  await comment("jo", "Jo was here");
  const p = await open("alex");
  const sheet = await samsDaySheet(p);
  await expect(sheet.getByRole("list", { name: "Comments" }).getByRole("listitem")).toHaveCount(1);
  await expect(sheet).not.toContainText("Jo was here");
  await expect(sheet.getByRole("button", { name: "React 😂" })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByRole("button", { name: "React 💩" })).toHaveAttribute("aria-pressed", "false");
  await p.context().close();
});

await c.check("Sam sees everyone's on the Log tab, with names, and deletes Jo's Comment", async () => {
  const p = await open("sam");
  const item = p.getByRole("listitem", { name: "Log at 07:00" });
  await expect(item.getByRole("list", { name: "Reactions" }).getByRole("listitem")).toHaveText(["😂 Alex", "💩 Jo"]);
  const comments = item.getByRole("list", { name: "Comments" });
  await expect(comments.getByRole("listitem")).toHaveCount(2);
  await expect(comments).toContainText("Alex Nice one");
  await expect(comments).toContainText("Jo Jo was here");
  await expect(item.getByRole("group", { name: "React" })).toHaveCount(0);
  await shot(p, "phone-reactions-owner-log-tab");
  await comments.getByRole("button", { name: "Delete Comment from Jo" }).click();
  await expect(comments.getByRole("listitem")).toHaveCount(1);
  await expect(comments).not.toContainText("Jo was here");
  await p.context().close();
});

await c.check("Sam's Calendar marks the Day and the Day sheet shows everyone's (dark)", async () => {
  const p = await open("sam", { dark: true });
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Calendar" }).click();
  await expect(marker(p)).toHaveCount(1);
  await shot(p, "phone-reactions-calendar-dark");
  await p.locator(`[data-day="${DAY}"]`).click();
  const sheet = p.getByRole("dialog");
  await expect(sheet.getByRole("list", { name: "Reactions" }).getByRole("listitem")).toHaveCount(2);
  await shot(p, "phone-reactions-owner-sheet-dark");
  await p.context().close();
});

await c.check("Alex takes the Reaction off and deletes their Comment", async () => {
  const p = await open("alex");
  const sheet = await samsDaySheet(p);
  await sheet.getByRole("button", { name: "React 😂" }).click();
  await expect(sheet.getByRole("button", { name: "React 😂" })).toHaveAttribute("aria-pressed", "false");
  await sheet.getByRole("button", { name: "Delete Comment from You" }).click();
  await expect(sheet.getByRole("list", { name: "Comments" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(marker(p)).toHaveCount(0);
  await p.context().close();
});

await c.check("Sam deleting the Log deletes its Reactions and Comments", async () => {
  await react("alex", "👏");
  await comment("alex", "again");
  const p = await open("sam");
  const item = p.getByRole("listitem", { name: "Log at 07:00" });
  await expect(item.getByRole("list", { name: "Reactions" })).toHaveCount(1);
  await item.getByRole("button", { name: "Delete Log at 07:00" }).click();
  await item.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(p.getByRole("listitem", { name: "Log at 07:00" })).toHaveCount(0);
  await expect.poll(() => responsesLeft().length).toBe(0);
  await p.context().close();
});

c.report();
await app.close();
