// Visual sweep (ticket 12): every screen on phone, desktop and dark phone, with Friends, Reactions,
// Comments and a Summary seeded. Screenshots in $OUT/tour-* (see lib.ts). Look at them: DOM checks miss
// layout bugs. On each screen it also checks, through Chromium's accessibility tree (what VoiceOver
// reads), that every button, link and form control has a name, and that no CSP violation happened.
import { randomUUID } from "node:crypto";
import { TIME_ZONE, launch, type Page } from "./app";
import { USERS, graphql, runSchedule, setServerClock } from "./backend";
import { OUT, checklist, shot } from "./lib";

// Monday 9 November 2026, 10:00 in Los Angeles: the Summary for Nov 2-8 has just been built.
const CLOCK = "2026-11-09T18:00:00Z";

async function gq(user: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await graphql(`fake-id.${user}`, query, variables);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
}
async function log(user: string, instant: string, details: Record<string, unknown> = {}) {
  setServerClock(instant);
  const id = randomUUID();
  await gq(user, `mutation C($log: NewLog!) { createLog(log: $log) { id } }`, { log: { id, instant, ...details } });
  return id;
}
async function befriend(a: string, b: string) {
  const { myFriendCode } = await gq(b, `query { myFriendCode }`);
  await gq(a, `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: myFriendCode });
  await gq(b, `mutation A($f: ID!) { acceptFriendRequest(from: $f) { id } }`, { f: USERS[a].sub });
}

// Sam (signed in) with Friends Alex and Jo; Max has sent Sam a Friend request.
const people: [string, string, string, string][] = [
  ["sam", "Sam", "👑", "#7c5cff"], ["alex", "Alex with a long name", "🦆", "#e8590c"], ["jo", "Jo", "🐸", "#2b8a3e"], ["max", "Max", "🦊", "#1c7ed6"],
];
setServerClock("2026-11-01T18:00:00Z");
for (const [user, name, emoji, color] of people) {
  await gq(user, `query { me(homeZone: "${TIME_ZONE}") { id } }`);
  await gq(user, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name, avatar: { emoji, color } } });
}
await befriend("sam", "alex");
await befriend("jo", "sam");
const { myFriendCode: samCode } = await gq("sam", `query { myFriendCode }`);
await gq("max", `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: samCode });
await gq("sam", `mutation { createInvite { token } }`);

let samLog = "";
for (let d = 2; d <= 8; d++) {
  const day = String(d).padStart(2, "0");
  const id = await log("sam", `2026-11-${day}T15:30:00Z`, d % 2 ? {} : { duration: 5 + d, bristolType: (d % 7) + 1, note: d === 8 ? "after the big coffee" : undefined, flags: d === 6 ? ["urgent"] : undefined });
  if (d === 8) samLog = id;
  if (d % 3 === 0) await log("sam", `2026-11-${day}T04:10:00Z`);
  if (d !== 5) await log("alex", `2026-11-${day}T14:00:00Z`);
  if (d % 2 === 0) await log("jo", `2026-11-${day}T23:00:00Z`);
}
setServerClock("2026-11-08T20:00:00Z");
await gq("alex", `mutation R($o: ID!, $l: ID!) { setReaction(owner: $o, log: $l, emoji: "👏") { id } }`, { o: USERS.sam.sub, l: samLog });
await gq("jo", `mutation R($o: ID!, $l: ID!) { setReaction(owner: $o, log: $l, emoji: "😂") { id } }`, { o: USERS.sam.sub, l: samLog });
await gq("alex", `mutation C($o: ID!, $l: ID!, $id: ID!) { addComment(owner: $o, log: $l, id: $id, text: "Respect. That's a long one.") { id } }`, { o: USERS.sam.sub, l: samLog, id: randomUUID() });
await runSchedule("2026-11-09T16:00:00Z");
setServerClock(CLOCK);
const { createInvite: invite } = await gq("sam", `mutation { createInvite { token } }`);

const app = await launch();
const c = checklist("tour");

/** Buttons, links and form controls with no accessible name (VoiceOver would read only the role). */
async function unnamed(p: Page): Promise<string[]> {
  const cdp = await p.context().newCDPSession(p);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: any[] };
  await cdp.detach();
  const roles = new Set(["button", "link", "textbox", "checkbox", "radio", "combobox", "switch", "slider", "spinbutton", "searchbox", "menuitem", "tab"]);
  return nodes
    .filter((n) => !n.ignored && roles.has(n.role?.value) && !String(n.name?.value ?? "").trim())
    .map((n) => `${n.role.value} (backend node ${n.backendDOMNodeId})`);
}

async function screen(p: Page, name: string) {
  await p.waitForTimeout(250);
  await shot(p, `tour-${name}`);
  await c.check(`${name}: every control has a name`, async () => {
    const bad = await unnamed(p);
    if (bad.length) throw new Error(bad.join(", "));
  });
}

async function go(p: Page, path: string) {
  await p.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function sweep(p: Page, name: string) {
  c.watch(p);
  await p.getByRole("button", { name: "Log now" }).waitFor();
  await screen(p, `${name}-01-log`);
  await p.getByRole("button", { name: /^Edit Log at/ }).first().click();
  await p.getByRole("dialog").waitFor();
  await screen(p, `${name}-02-log-details`);
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Cancel" }).click().catch(() => {});
  await p.getByRole("link", { name: "Calendar" }).click();
  await p.getByRole("group", { name: "Whose Calendar" }).waitFor();
  await screen(p, `${name}-03-calendar-me`);
  await p.locator('[data-day="2026-11-08"] button').click();
  await p.getByRole("dialog").waitFor();
  await screen(p, `${name}-04-day-sheet`);
  await p.keyboard.press("Escape");
  await p.getByRole("dialog").getByRole("button", { name: /Close|Done/ }).click().catch(() => {});
  await p.getByRole("group", { name: "Whose Calendar" }).getByRole("button", { name: /Everyone/ }).click();
  await screen(p, `${name}-05-calendar-everyone`);
  await p.getByRole("link", { name: "Friends" }).click();
  await p.getByText("Friend code", { exact: false }).first().waitFor();
  await screen(p, `${name}-06-friends`);
  await p.getByRole("link", { name: "Settings" }).click();
  await p.getByRole("button", { name: /Delete/ }).last().waitFor();
  await screen(p, `${name}-07-settings`);
  await go(p, "/summary");
  await p.getByText("Awards", { exact: false }).first().waitFor({ timeout: 5000 }).catch(() => {});
  await screen(p, `${name}-08-summary`);
}

await sweep(await app.open("sam", { clock: CLOCK }), "phone");
await sweep(await app.open("sam", { clock: CLOCK, device: "desktop" }), "desktop");
await sweep(await app.open("sam", { clock: CLOCK, dark: true }), "dark");
for (const [device, dark, label] of [["phone", false, "phone"], ["phone", true, "dark"], ["desktop", false, "desktop"]] as const) {
  const out = await app.open("sam", { signedOut: true, device, dark });
  c.watch(out);
  await out.getByRole("button", { name: /Sign in/ }).first().waitFor();
  await screen(out, `${label}-00-login`);
  const join = await app.open("newbie", { signedOut: true, device, dark, path: `/invite#${invite.token}` });
  c.watch(join);
  await join.getByRole("heading", { name: "Join Throne" }).waitFor();
  await screen(join, `${label}-09-join`);
}
// The name check itself: an icon-only button with no label must be caught.
const probe = await app.open("sam", { signedOut: true });
await probe.getByRole("button", { name: /Sign in/ }).first().waitFor();
await c.check("the name check catches an unnamed button", async () => {
  await probe.evaluate(() => document.body.append(Object.assign(document.createElement("button"), { type: "button" })));
  if (!(await unnamed(probe)).length) throw new Error("an unnamed button went unnoticed");
});
await app.close();
console.log(`screenshots in ${OUT}/tour-*.png`);
c.report();
