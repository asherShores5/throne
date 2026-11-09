// Offline outbox (ticket 04): Logs made, edited and deleted with no signal show at once, marked
// "Waiting to sync", survive a reload (the service worker opens the app offline), and reach the
// backend exactly once, in order, when the phone is back online. A lost answer is retried without a
// duplicate; a Log more than 7 days old by the time it arrives is dropped with a clear message.
import { expect } from "playwright/test";
import { GRAPHQL_URL, launch, setOffline, type Page } from "./app";
import { USERS, calls, db, graphql, setServerClock } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("offline");

/** Sam's stored Logs (not the id/count helper items). */
const samLogs = () => db.dump().filter((r) => r.PK === `PROFILE#${USERS.sam.sub}` && String(r.SK).startsWith("LOG#"));
const creates = () => calls.filter((x) => x.user === "sam" && x.field === "createLog").length;
const recent = (p: Page) => p.getByRole("region", { name: "Recent Logs" });
const pending = (p: Page) => recent(p).getByText("Waiting to sync");

async function home(opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  const p = await app.open("sam", opts);
  c.watch(p);
  await expect(p.getByRole("button", { name: "Log now" })).toBeVisible();
  return p;
}

await c.check("a Log made offline shows at once as waiting, survives a reload, and syncs exactly once on reconnect", async () => {
  db.reset();
  setServerClock(new Date());
  const p = await home({ serviceWorkers: true });
  await p.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect(p.getByText("No Logs in the last 7 days.")).toBeVisible();
  await setOffline(p, true);
  await p.getByRole("button", { name: "Log now" }).click();
  await expect(p.getByRole("status")).toContainText("Logged at");
  await expect(pending(p)).toHaveCount(1);
  await expect(p.getByText("Offline. 1 change will sync when you're back online.")).toBeVisible();
  await shot(p, "phone-offline-pending");
  await p.reload(); // like closing the app on a train and opening it again
  await expect(p.getByRole("button", { name: "Log now" })).toBeVisible();
  await expect(pending(p)).toHaveCount(1);
  expect(samLogs()).toEqual([]);
  await setOffline(p, false);
  await expect.poll(() => samLogs().length).toBe(1);
  await expect(pending(p)).toHaveCount(0);
  await expect(recent(p).getByRole("listitem")).toHaveCount(1);
  await p.waitForTimeout(500);
  expect(samLogs()).toHaveLength(1);
  await p.context().close();
});

await c.check("offline creates, edits and deletes replay in order: an offline Undo never reaches the server, Details added offline land with the Log", async () => {
  db.reset();
  setServerClock(new Date());
  const p = await home();
  // One synced Log to edit and one to delete while offline.
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("button", { name: "Log now" }).click();
  await expect.poll(() => samLogs().length).toBe(2);
  await expect(pending(p)).toHaveCount(0);
  const before = creates();
  await setOffline(p, true);
  // A new Log, then Details on it, all offline.
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("status").getByRole("button", { name: "Add details" }).click();
  await p.getByRole("dialog").getByRole("radio").nth(3).click(); // Bristol type 4
  await p.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  // Another new Log, undone right away.
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("status").getByRole("button", { name: "Undo" }).click();
  // Delete one of the synced Logs.
  const items = recent(p).getByRole("listitem");
  await expect(items).toHaveCount(3);
  await items.last().getByRole("button", { name: /^Delete/ }).click();
  await items.last().getByRole("button", { name: "Delete", exact: true }).click();
  await expect(items).toHaveCount(2);
  await expect(pending(p)).toHaveCount(1);
  expect(samLogs()).toHaveLength(2);
  await shot(p, "phone-offline-mixed");
  await setOffline(p, false);
  await expect(pending(p)).toHaveCount(0);
  await expect.poll(() => samLogs().length).toBe(2);
  expect(samLogs().filter((l) => l.bristolType === 4)).toHaveLength(1);
  // The undone Log was forgotten on the device: only the one new create went out.
  expect(creates() - before).toBe(1);
  await p.context().close();
});

await c.check("a lost answer is retried with the same id: the Log is stored once", async () => {
  db.reset();
  setServerClock(new Date());
  const p = await home();
  let dropped = 0;
  // The first createLog reaches the backend and is saved, but its answer never comes back.
  await p.context().route(GRAPHQL_URL, async (route) => {
    const body = route.request().postDataJSON();
    if (dropped === 0 && String(body.query).includes("createLog")) {
      dropped++;
      await graphql(route.request().headers()["authorization"], body.query, body.variables);
      return route.abort("connectionreset");
    }
    return route.fallback();
  });
  await p.getByRole("button", { name: "Log now" }).click();
  await expect.poll(() => samLogs().length).toBe(1);
  await expect(pending(p)).toHaveCount(1);
  await p.evaluate(() => window.dispatchEvent(new Event("focus"))); // coming back to the app sends again
  await expect(pending(p)).toHaveCount(0);
  expect(dropped).toBe(1);
  expect(creates()).toBeGreaterThanOrEqual(2);
  expect(samLogs()).toHaveLength(1);
  await p.context().close();
});

await c.check("a Log that reaches the server more than 7 days after it was made is dropped with a clear message", async () => {
  db.reset();
  const made = "2026-11-08T18:00:00Z"; // 10:00 in Los Angeles
  setServerClock(made);
  const p = await home({ clock: made });
  await setOffline(p, true);
  await p.getByRole("button", { name: "Log now" }).click();
  await expect(pending(p)).toHaveCount(1);
  // Eight days pass on the server before the phone gets signal again.
  setServerClock("2026-11-16T18:00:00Z");
  await setOffline(p, false);
  const notice = p.getByRole("alert").filter({ hasText: "wasn't saved" });
  await expect(notice).toHaveText(/Your Log from 2026-11-08 at 10:00 reached the server more than 7 days later, so it wasn't saved\./);
  await expect(pending(p)).toHaveCount(0);
  await expect(p.getByText("No Logs in the last 7 days.")).toBeVisible();
  expect(samLogs()).toEqual([]);
  expect(await p.evaluate(() => Object.entries(localStorage).filter(([k, v]) => k.startsWith("throne.outbox") && v !== "[]").length)).toBe(0);
  await shot(p, "phone-too-old");
  await notice.getByRole("button", { name: "OK" }).click();
  await expect(notice).toHaveCount(0);
  await p.context().close();
});

await c.check("dark mode: the waiting marker and offline note read clearly", async () => {
  db.reset();
  setServerClock(new Date());
  const p = await home({ dark: true });
  await p.getByRole("button", { name: "Log now" }).click();
  await expect.poll(() => samLogs().length).toBe(1);
  await setOffline(p, true);
  await p.getByRole("button", { name: "Log now" }).click();
  await expect(pending(p)).toHaveCount(1);
  await p.waitForTimeout(6500); // let the toast go
  await shot(p, "dark-offline-pending");
  await p.context().close();
});

c.report();
await app.close();
