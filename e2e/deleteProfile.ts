// Delete Profile (ticket 11): Settings asks for the word "delete" typed before the button works; deleting signs
// this device out with a notice, the device forgets the Profile, the server keeps nothing of it, the Cognito user
// can't sign in, and Friends stop seeing them. Offline, nothing happens and it says so. A deletion stopped half
// way finishes by itself the next time the app opens. Screenshots: phone, dark phone.
import { expect } from "playwright/test";
import { PutCommand, TransactWriteCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { TIME_ZONE, launch, setOffline, type Page } from "./app";
import { PASSWORD, db, deletedUsers, graphql } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("delete");

async function gq(user: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await graphql(`fake-id.${user}`, query, variables);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
}

async function seed() {
  db.reset();
  for (const [user, name] of [["sam", "Sam"], ["alex", "Alex"], ["jo", "Jo"]]) {
    await gq(user, `query { me(homeZone: "${TIME_ZONE}") { id } }`);
    await gq(user, `mutation U($i: ProfileInput!) { updateProfile(input: $i) { id } }`, { i: { displayName: name } });
  }
  for (const other of ["sam", "jo"]) {
    const { myFriendCode } = await gq(other, `query { myFriendCode }`);
    await gq("alex", `mutation S($c: String!) { sendFriendRequest(code: $c) }`, { c: myFriendCode });
    await gq(other, `mutation A($f: ID!) { acceptFriendRequest(from: $f) { id } }`, { f: "sub-alex" });
  }
  await gq("alex", `mutation L($l: NewLog!) { createLog(log: $l) { id } }`, { l: { id: crypto.randomUUID(), note: "alex was here" } });
  await gq("alex", `mutation { createInvite { token } }`);
}

async function settings(user: string, opts = {}): Promise<Page> {
  const p = await app.open(user, { path: "/settings", ...opts });
  c.watch(p);
  await expect(p.getByRole("heading", { name: "Settings" })).toBeVisible();
  return p;
}

const section = (p: Page) => p.getByRole("region", { name: "Delete Profile" });
const leftOf = (sub: string) => db.dump().filter((r) => JSON.stringify(r).includes(sub) && !(r.PK === `PROFILE#${sub}` && r.SK === "DELETED"));
const throneKeys = (p: Page) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("throne.")).sort());

await seed();

await c.check("Settings: Delete Profile needs a second step and the word typed; Keep closes it", async () => {
  const p = await settings("alex");
  const s = section(p);
  await expect(s).toContainText("can't be undone");
  await s.getByRole("button", { name: "Delete Profile…" }).click();
  const go = s.getByRole("button", { name: "Delete my Profile" });
  await expect(go).toBeDisabled();
  await s.getByLabel(/Type .delete. to confirm/).fill("nope");
  await expect(go).toBeDisabled();
  await s.getByLabel(/Type .delete. to confirm/).fill("Delete");
  await expect(go).toBeEnabled();
  await s.getByLabel(/Type .delete. to confirm/).press("End");
  await shot(p, "phone-delete-confirm");
  await s.getByRole("button", { name: "Keep my Profile" }).click();
  await expect(s.getByRole("button", { name: "Delete Profile…" })).toBeVisible();
  expect(leftOf("sub-alex").length).toBeGreaterThan(0);
  await p.context().close();
});

await c.check("offline: Delete Profile says it couldn't, stays signed in, and nothing is deleted", async () => {
  const p = await settings("alex");
  const s = section(p);
  await s.getByRole("button", { name: "Delete Profile…" }).click();
  await s.getByLabel(/Type .delete. to confirm/).fill("delete");
  await setOffline(p, true);
  await s.getByRole("button", { name: "Delete my Profile" }).click();
  await expect(s.getByRole("alert")).toContainText("try again");
  await expect(p.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(deletedUsers.has("alex")).toBe(false);
  expect(db.dump().some((r) => r.PK === "PROFILE#sub-alex" && r.SK === "DELETED")).toBe(false);
  await p.context().close();
});

await c.check("delete: signed out with a notice, this device forgets Alex, nothing of Alex left on the server, no sign-in", async () => {
  const p = await settings("alex");
  // Something to forget: the cached Profile and Logs from opening Home.
  await p.goto(p.url().replace("/settings", "/"));
  await expect(p.getByRole("button", { name: /^Log/ }).first()).toBeVisible();
  await p.getByRole("link", { name: "Settings" }).click();
  expect((await throneKeys(p)).some((k) => k.endsWith(":alex"))).toBe(true);
  const s = section(p);
  await s.getByRole("button", { name: "Delete Profile…" }).click();
  await s.getByLabel(/Type .delete. to confirm/).fill("delete");
  await s.getByRole("button", { name: "Delete my Profile" }).click();
  await expect(p.getByRole("form", { name: "Sign in" })).toBeVisible();
  await expect(p.getByRole("status")).toHaveText("Your Profile is deleted. Everything you made is gone.");
  await shot(p, "phone-delete-done");
  expect(new URL(p.url()).pathname).toBe("/");
  const keys = await throneKeys(p);
  expect(keys.filter((k) => k.includes("alex") || k === "throne.tokens" || k === "throne.lastUser")).toEqual([]);
  expect(leftOf("sub-alex")).toEqual([]);
  expect(deletedUsers.has("alex")).toBe(true);
  // The password no longer works.
  await p.getByRole("button", { name: "Use password instead" }).click();
  await p.getByLabel("Username").fill("alex");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in with password" }).click();
  await expect(p.getByRole("alert")).toContainText("Incorrect username or password");
  await p.context().close();
});

await c.check("Sam's Friends tab and Calendar no longer show Alex", async () => {
  const p = await app.open("sam", { path: "/friends" });
  c.watch(p);
  const list = p.getByRole("region", { name: "Friends", exact: true });
  await expect(list).toContainText("0 of 3");
  await expect(list).not.toContainText("Alex");
  await p.goto(p.url().replace("/friends", "/calendar"));
  await expect(p.getByRole("heading", { level: 2 }).first()).toBeVisible();
  await expect(p.getByText("Alex")).toHaveCount(0);
  await p.context().close();
});

await c.check("a deletion stopped half way (app closed) finishes by itself the next time the app opens", async () => {
  await seed();
  deletedUsers.clear();
  // The server got as far as the marker and the directory entry, then the Lambda died.
  const real = db.send;
  let writes = 0;
  db.send = async function (cmd: unknown) {
    const write = cmd instanceof PutCommand || cmd instanceof UpdateCommand || cmd instanceof DeleteCommand || cmd instanceof TransactWriteCommand;
    if (write && ++writes > 2) throw Object.assign(new Error("Task timed out"), { name: "TimeoutError" });
    return real.call(db, cmd);
  } as typeof real;
  const r = await graphql("fake-id.jo", `mutation { deleteProfile }`);
  db.send = real;
  if (!r.errors) throw new Error("expected the first try to fail");
  expect(leftOf("sub-jo").length).toBeGreaterThan(0);

  const p = await app.open("jo");
  c.watch(p);
  await expect(p.getByRole("status")).toHaveText("Your Profile is deleted. Everything you made is gone.");
  expect(leftOf("sub-jo")).toEqual([]);
  expect(deletedUsers.has("jo")).toBe(true);
  await p.context().close();
});

await c.check("dark phone: the confirm step", async () => {
  const p = await settings("sam", { dark: true });
  const s = section(p);
  await s.getByRole("button", { name: "Delete Profile…" }).click();
  await s.getByLabel(/Type .delete. to confirm/).fill("del");
  await s.scrollIntoViewIfNeeded();
  await shot(p, "phone-delete-dark");
  await p.context().close();
});

c.report();
await app.close();
