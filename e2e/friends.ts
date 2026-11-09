// Friends (ticket 06): the Friends tab shows my Friend code; someone types it and sends a Friend request;
// I see their Display name and Avatar and accept or decline; the sender can cancel; sending to someone
// who already asked you makes you Friends; a bad or regenerated code says "not found"; ending a
// Friendship (after a confirmation) removes it for both. Screenshots: phone, dark phone, desktop.
import { expect } from "playwright/test";
import { TIME_ZONE, launch, type Page } from "./app";
import { db, graphql } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("friends");
const NOT_FOUND = "No Profile has that Friend code.";

async function seedProfiles() {
  db.reset();
  for (const [user, name, emoji, color] of [
    ["sam", "Sam", "👑", "#7c5cff"], ["alex", "Alex", "🦆", "#e8590c"], ["jo", "Jo", "🐸", "#2b8a3e"], ["max", "Max", "🦊", "#1c7ed6"],
  ]) {
    await graphql(`fake-id.${user}`, `query { me(homeZone: "${TIME_ZONE}") { id } }`);
    const r = await graphql(`fake-id.${user}`, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name, avatar: { emoji, color } } });
    if (r.errors) throw new Error(JSON.stringify(r.errors));
  }
}

async function friendsTab(user: string, opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  const p = await app.open(user, opts);
  c.watch(p);
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Friends" }).click();
  await expect(p.getByLabel("Friend code", { exact: true })).toHaveText(/^[2-9A-Z]{3}-[2-9A-Z]{3}$/);
  return p;
}

const codeOn = async (p: Page) => (await p.getByLabel("Friend code", { exact: true }).textContent())!;
async function codeOf(user: string) {
  const r = await graphql(`fake-id.${user}`, `query { myFriendCode }`);
  return r.data.myFriendCode as string;
}

async function sendCode(p: Page, code: string) {
  await p.getByLabel("Their Friend code").fill(code);
  await p.getByRole("button", { name: "Send Friend request" }).click();
}

const friendsList = (p: Page) => p.getByRole("region", { name: "Friends", exact: true });

await seedProfiles();

await c.check("Sam's Friends tab shows a Friend code in two groups of 3 and no Friends yet", async () => {
  const p = await friendsTab("sam");
  expect(new URL(p.url()).pathname).toBe("/friends");
  await expect(friendsList(p)).toContainText("0 of 3");
  await expect(friendsList(p)).toContainText("No Friends yet");
  await shot(p, "phone-friends-empty");
  await p.context().close();
});

await c.check("Alex: a wrong code says not found; Sam's code (typed lowercase, no dash) sends a Friend request", async () => {
  const sam = await codeOf("sam");
  const p = await friendsTab("alex");
  await sendCode(p, "zzz-zzz");
  await expect(p.getByRole("alert")).toHaveText(NOT_FOUND);
  await sendCode(p, "abc");
  await expect(p.getByRole("alert")).toContainText("6 letters and digits");
  await sendCode(p, sam.replace("-", "").toLowerCase());
  await expect(p.getByRole("status")).toHaveText("Friend request sent.");
  await expect(p.getByRole("region", { name: "Sent requests" })).toContainText(`To ${sam}`);
  await p.context().close();
});

await c.check("Sam sees Alex's request with Display name and Avatar, accepts; both see each other", async () => {
  const p = await friendsTab("sam");
  const reqs = p.getByRole("region", { name: "Friend requests" });
  await expect(reqs.getByRole("listitem")).toHaveCount(1);
  await expect(reqs).toContainText("Alex");
  await expect(reqs.getByRole("img", { name: "Alex's Avatar" })).toBeVisible();
  await shot(p, "phone-friends-request");
  await reqs.getByRole("button", { name: "Accept" }).click();
  await expect(friendsList(p).getByText("Alex")).toBeVisible();
  await expect(friendsList(p)).toContainText("1 of 3");
  await expect(p.getByRole("region", { name: "Friend requests" })).toHaveCount(0);
  await p.context().close();
  const a = await friendsTab("alex");
  await expect(friendsList(a).getByText("Sam")).toBeVisible();
  await expect(a.getByRole("region", { name: "Sent requests" })).toHaveCount(0);
  await a.context().close();
});

await c.check("Sam declines Jo's request; Jo's sent request is gone too", async () => {
  await graphql("fake-id.jo", `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: await codeOf("sam") });
  const p = await friendsTab("sam");
  const reqs = p.getByRole("region", { name: "Friend requests" });
  await expect(reqs).toContainText("Jo");
  await reqs.getByRole("button", { name: "Decline" }).click();
  await expect(p.getByRole("region", { name: "Friend requests" })).toHaveCount(0);
  await expect(friendsList(p)).toContainText("1 of 3");
  await p.context().close();
  const j = await friendsTab("jo");
  await expect(j.getByRole("region", { name: "Sent requests" })).toHaveCount(0);
  await j.context().close();
});

await c.check("Max cancels a request to Sam before Sam answers", async () => {
  const sam = await codeOf("sam");
  const p = await friendsTab("max");
  await sendCode(p, sam);
  const sent = p.getByRole("region", { name: "Sent requests" });
  await expect(sent).toContainText(sam);
  await sent.getByRole("button", { name: "Cancel" }).click();
  await expect(p.getByRole("region", { name: "Sent requests" })).toHaveCount(0);
  await p.context().close();
  const s = await friendsTab("sam");
  await expect(s.getByRole("region", { name: "Friend requests" })).toHaveCount(0);
  await s.context().close();
});

await c.check("Max enters the code of Jo, who already asked Max: they're Friends at once", async () => {
  await graphql("fake-id.jo", `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: await codeOf("max") });
  const p = await friendsTab("max");
  await sendCode(p, await codeOf("jo"));
  await expect(p.getByRole("status")).toContainText("you're Friends now");
  await expect(friendsList(p).getByText("Jo")).toBeVisible();
  await expect(p.getByRole("region", { name: "Friend requests" })).toHaveCount(0);
  await p.context().close();
});

await c.check("Sam regenerates the Friend code after a confirmation; the old one is not found", async () => {
  const p = await friendsTab("sam");
  const old = await codeOn(p);
  await p.getByRole("button", { name: "Regenerate" }).click();
  await expect(p.getByRole("group", { name: "Regenerate Friend code" })).toContainText("old one stops working");
  await p.getByRole("button", { name: "New code" }).click();
  await expect(p.getByLabel("Friend code", { exact: true })).not.toHaveText(old);
  await p.context().close();
  const j = await friendsTab("jo");
  await sendCode(j, old);
  await expect(j.getByRole("alert")).toHaveText(NOT_FOUND);
  await j.context().close();
});

await c.check("Sam ends the Friendship with Alex after confirming; it's gone for both", async () => {
  const p = await friendsTab("sam");
  await friendsList(p).getByRole("button", { name: "End…" }).click();
  const confirm = p.getByRole("group", { name: "End Friendship with Alex" });
  await expect(confirm).toContainText("stop seeing each other's Logs");
  await shot(p, "phone-friends-end-confirm");
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(friendsList(p).getByText("Alex")).toBeVisible();
  await friendsList(p).getByRole("button", { name: "End…" }).click();
  await p.getByRole("button", { name: "End Friendship" }).click();
  await expect(friendsList(p)).toContainText("0 of 3");
  await p.context().close();
  const a = await friendsTab("alex");
  await expect(friendsList(a)).toContainText("No Friends yet");
  await a.context().close();
});

await c.check("screenshots: dark phone and desktop with a request, a Friend and a sent request", async () => {
  await graphql("fake-id.alex", `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: await codeOf("jo") });
  await graphql("fake-id.jo", `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: await codeOf("sam") });
  const dark = await friendsTab("jo", { dark: true });
  await expect(dark.getByRole("region", { name: "Friend requests" })).toContainText("Alex");
  await expect(friendsList(dark).getByText("Max")).toBeVisible();
  await expect(dark.getByRole("region", { name: "Sent requests" })).toBeVisible();
  await shot(dark, "phone-friends-dark");
  await dark.context().close();
  const desk = await friendsTab("jo", { device: "desktop" });
  await shot(desk, "desktop-friends");
  await desk.context().close();
});

c.report();
await app.close();
