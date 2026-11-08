// One-tap Log (ticket 03): tap the big button and a Log is saved for now; Undo removes it; the details
// sheet adds Details and moves the time; edit and delete from the recent list. Screenshots: phone, dark, desktop.
import { expect } from "playwright/test";
import { launch, type Page } from "./app";
import { USERS, db, setServerClock } from "./backend";
import { checklist, lastCall, shot } from "./lib";

const app = await launch();
const c = checklist("log");

/** Sam's stored Logs (not the id/count helper items). */
const samLogs = () => db.dump().filter((r) => r.PK === `PROFILE#${USERS.sam.sub}` && String(r.SK).startsWith("LOG#"));
// 10:00 in Los Angeles (the page's zone), so "an hour ago" and "yesterday" stay on clear Days.
const CLOCK = "2026-11-08T18:00:00Z";

async function home(opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  setServerClock(CLOCK);
  const p = await app.open("sam", { clock: CLOCK, ...opts });
  c.watch(p);
  await expect(p.getByRole("button", { name: "Log now" })).toBeVisible();
  return p;
}

await c.check("one tap saves a Log for now in the Home zone and shows it under Today, with an Undo toast", async () => {
  db.reset();
  const p = await home();
  await expect(p.getByText("No Logs in the last 7 days.")).toBeVisible();
  await p.getByRole("button", { name: "Log now" }).click();
  await expect(p.getByRole("status")).toContainText("Logged at 10:00.");
  await expect(p.getByRole("region", { name: "Today" }).getByRole("listitem")).toHaveCount(1);
  const [log] = samLogs();
  expect([log.logZone, log.day]).toEqual(["America/Los_Angeles", "2026-11-08"]);
  // The id is the client's (a UUID), so a retry would be the same Log.
  expect((lastCall("createLog")?.args as { log: { id: string } }).log.id).toBe(log.id);
  await shot(p, "phone-logged-toast");
  await p.context().close();
});

await c.check("Undo in the toast removes the Log everywhere", async () => {
  db.reset();
  const p = await home();
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(p.getByRole("status")).toContainText("Log undone.");
  await expect(p.getByText("No Logs in the last 7 days.")).toBeVisible();
  expect(samLogs()).toEqual([]);
  await p.context().close();
});

await c.check("the toast goes away by itself after a few seconds; the Log stays", async () => {
  db.reset();
  const p = await home();
  await p.getByRole("button", { name: "Log now" }).click();
  await expect(p.getByRole("button", { name: "Undo" })).toBeVisible();
  await p.clock.runFor(7000);
  await expect(p.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(samLogs()).toHaveLength(1);
  await p.context().close();
});

await c.check("Add details: Duration, Bristol type, Note and Flags, saved and shown", async () => {
  db.reset();
  const p = await home();
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("button", { name: "Add details" }).click();
  const sheet = p.getByRole("dialog", { name: "Log details" });
  await sheet.getByLabel("Duration (minutes)").fill("12");
  await sheet.getByRole("radio", { name: /4 Smooth/ }).click();
  await sheet.getByRole("button", { name: "Urgent" }).click();
  await sheet.getByRole("button", { name: "Pain" }).click();
  await sheet.getByLabel("Note").fill("after coffee");
  await shot(p, "phone-details-sheet");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toHaveCount(0);
  const item = p.getByRole("listitem", { name: "Log at 10:00" });
  await expect(item).toContainText("4 Smooth");
  await expect(item).toContainText("12 min");
  await expect(item).toContainText("Urgent");
  await expect(item).toContainText("after coffee");
  const [log] = samLogs();
  expect([log.duration, log.bristolType, log.note, log.flags]).toEqual([12, 4, "after coffee", ["urgent", "pain"]]);
  await shot(p, "phone-home-with-log");
  await p.context().close();
});

await c.check("the details sheet refuses bad Details with the server's rule, and a time in the future", async () => {
  db.reset();
  const p = await home();
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("button", { name: "Add details" }).click();
  const sheet = p.getByRole("dialog", { name: "Log details" });
  await sheet.getByLabel("Duration (minutes)").fill("500");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Duration is 1 to 180 minutes.");
  await sheet.getByLabel("Duration (minutes)").fill("");
  await sheet.getByLabel("Time").fill("11:30");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("A Log can't be in the future.");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  expect(samLogs()[0].duration).toBeUndefined();
  await p.context().close();
});

await c.check("edit later: move a Log to yesterday evening; it moves under Yesterday", async () => {
  db.reset();
  const p = await home();
  await p.getByRole("button", { name: "Log now" }).click();
  await p.getByRole("button", { name: "Edit Log at 10:00" }).click();
  const sheet = p.getByRole("dialog", { name: "Log details" });
  await sheet.getByLabel("Date").fill("2026-11-07");
  await sheet.getByLabel("Time").fill("21:15");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(p.getByRole("region", { name: "Yesterday" }).getByRole("listitem", { name: "Log at 21:15" })).toBeVisible();
  await expect(p.getByRole("region", { name: "Today" })).toHaveCount(0);
  const [log] = samLogs();
  expect([log.day, log.instant]).toEqual(["2026-11-07", "2026-11-08T05:15:00.000Z"]);
  await p.context().close();
});

await c.check("delete asks once, then removes the Log; reopening the app shows it's gone", async () => {
  db.reset();
  const p = await home();
  await p.getByRole("button", { name: "Log now" }).click();
  await p.clock.runFor(7000);
  await p.getByRole("button", { name: "Delete Log at 10:00" }).click();
  await p.getByRole("button", { name: "Keep" }).click();
  expect(samLogs()).toHaveLength(1);
  await p.getByRole("button", { name: "Delete Log at 10:00" }).click();
  await shot(p, "phone-delete-confirm");
  await p.getByRole("listitem", { name: "Log at 10:00" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(p.getByText("No Logs in the last 7 days.")).toBeVisible();
  expect(samLogs()).toEqual([]);
  await p.reload();
  await expect(p.getByText("No Logs in the last 7 days.")).toBeVisible();
  await p.context().close();
});

await c.check("screenshots: dark phone and desktop with a few Logs", async () => {
  db.reset();
  const dark = await home({ dark: true });
  await dark.getByRole("button", { name: "Log now" }).click();
  await dark.getByRole("button", { name: "Add details" }).click();
  const sheet = dark.getByRole("dialog", { name: "Log details" });
  await sheet.getByRole("radio", { name: /6 Mushy/ }).click();
  await sheet.getByRole("button", { name: "Diarrhea" }).click();
  await shot(dark, "phone-details-sheet-dark");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(dark.getByRole("listitem")).toHaveCount(1);
  await shot(dark, "phone-home-dark");
  await dark.context().close();
  const desk = await home({ device: "desktop" });
  await expect(desk.getByRole("listitem")).toHaveCount(1);
  await desk.getByRole("button", { name: "Log now" }).click();
  await shot(desk, "desktop-home-logs");
  await desk.getByRole("button", { name: "Add details" }).click();
  await shot(desk, "desktop-details-sheet");
  await desk.context().close();
});

c.report();
await app.close();
