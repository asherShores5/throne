// My Calendar (ticket 05): a month grid of my Logs (weeks start Monday, today highlighted, a count and
// heat shade per Day, blank Days with none), prev/next month, the monthly total and daily average, the
// Day sheet (times, Details, edit/delete), and refresh on focus and pull-to-refresh.
// Screenshots: phone, dark phone, desktop, Day sheet.
import { randomUUID } from "node:crypto";
import { expect } from "playwright/test";
import { TIME_ZONE, launch, type Page } from "./app";
import { calls, db, graphql, setServerClock } from "./backend";
import { checklist, shot } from "./lib";

const app = await launch();
const c = checklist("calendar");

// Sunday 8 November 2026, 10:00 in Los Angeles (the page's zone).
const CLOCK = "2026-11-08T18:00:00Z";

/** Make a Log for sam through the real handler, as if made at that moment (server clock moved there). */
async function seed(instant: string, details: Record<string, unknown> = {}) {
  setServerClock(instant);
  const r = await graphql("fake-id.sam", `mutation C($log: NewLog!) { createLog(log: $log) { id } }`, { log: { id: randomUUID(), instant, ...details } });
  if (r.errors) throw new Error(JSON.stringify(r.errors));
}

/**
 * Sam's month (Los Angeles times): Oct 20 one; Nov 2 one; Nov 5 two; Nov 6 five; Nov 7 three; Nov 8 one with
 * Details at 09:15. November total 12 over 8 Days = 1.5 a Day.
 */
async function seedMonth() {
  db.reset();
  await graphql("fake-id.sam", `query { me(homeZone: "${TIME_ZONE}") { id } }`);
  await seed("2026-10-20T15:00:00Z");
  await seed("2026-11-02T15:30:00Z");
  for (const h of [15, 20]) await seed(`2026-11-05T${h}:00:00Z`);
  for (const h of [14, 16, 18, 20, 22]) await seed(`2026-11-06T${h}:00:00Z`);
  for (const h of [15, 19, 23]) await seed(`2026-11-07T${h}:00:00Z`);
  await seed("2026-11-08T17:15:00Z", { duration: 12, bristolType: 4, note: "after coffee", flags: ["urgent"] });
}

async function calendar(opts: Parameters<typeof app.open>[1] = {}): Promise<Page> {
  setServerClock(CLOCK);
  const p = await app.open("sam", { clock: CLOCK, ...opts });
  c.watch(p);
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Calendar" }).click();
  await expect(p).toHaveURL(/\/calendar$/);
  await expect(p.getByRole("heading", { name: "November 2026" })).toBeVisible();
  return p;
}

const cell = (p: Page, day: string) => p.locator(`[data-day="${day}"]`);

await c.check("the Calendar tab shows this month with weeks starting Monday and today highlighted", async () => {
  await seedMonth();
  const p = await calendar();
  const heads = await p.getByRole("grid").getByRole("columnheader").allTextContents();
  expect(heads).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  // November 2026 starts on a Sunday: six blank cells, then the 1st under Sun.
  const firstRow = p.getByRole("grid").getByRole("row").nth(1).getByRole("gridcell");
  await expect(firstRow).toHaveCount(7);
  await expect(firstRow.nth(6)).toHaveAttribute("data-day", "2026-11-01");
  await expect(firstRow.nth(0)).not.toHaveAttribute("data-day", /.*/);
  await expect(cell(p, "2026-11-08")).toHaveAttribute("aria-current", "date");
  await expect(p.locator("[aria-current=date]")).toHaveCount(1);
  await shot(p, "phone-calendar");
  await p.context().close();
});

await c.check("each Day shows its count and heat shade; Days with no Logs stay blank", async () => {
  await seedMonth();
  const p = await calendar();
  const expected: Record<string, [string, string]> = {
    "2026-11-01": ["", "0"], "2026-11-02": ["1", "1"], "2026-11-05": ["2", "2"], "2026-11-06": ["5", "4"],
    "2026-11-07": ["3", "3"], "2026-11-08": ["1", "1"],
  };
  for (const [day, [count, heat]] of Object.entries(expected)) {
    await expect(cell(p, day).locator(".count")).toHaveText(count);
    await expect(cell(p, day)).toHaveAttribute("data-heat", heat);
  }
  // Four distinct shades, and a blank Day has no shade.
  const bg = (day: string) => cell(p, day).evaluate((e) => getComputedStyle(e).backgroundColor);
  const shades = await Promise.all(["2026-11-02", "2026-11-05", "2026-11-07", "2026-11-06"].map(bg));
  expect(new Set(shades).size).toBe(4);
  expect(shades).not.toContain(await bg("2026-11-01"));
  await p.context().close();
});

await c.check("one range query for the month: first to last Day", async () => {
  await seedMonth();
  setServerClock(CLOCK);
  const p = await app.open("sam", { clock: CLOCK });
  c.watch(p);
  // The Log tab's recent list makes its own 7-day query first; count only what the Calendar asks for.
  await expect(p.getByText("No Logs in the last 7 days.").or(p.getByRole("region", { name: "Recent Logs" }).getByRole("listitem").first())).toBeVisible();
  const before = calls.length;
  await p.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Calendar" }).click();
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("5");
  // Every Calendar load is the whole month at once (a focus refresh may repeat it, never split it).
  // A focus resume (sync/logs.ts) that fires before the Calendar asks may repeat the Log tab's own range
  // (Nov 1-9 here); that one isn't the Calendar's.
  const LOG_TAB = JSON.stringify({ from: "2026-11-01", to: "2026-11-09" });
  const month = calls.slice(before).filter((x) => x.field === "myLogs" && JSON.stringify(x.args) !== LOG_TAB);
  expect(month.length).toBeGreaterThan(0);
  expect([...new Set(month.map((x) => JSON.stringify(x.args)))]).toEqual([JSON.stringify({ from: "2026-11-01", to: "2026-11-30" })]);
  await p.context().close();
});

await c.check("monthly total and daily average under the grid", async () => {
  await seedMonth();
  const p = await calendar();
  const stats = p.getByRole("region", { name: "Month totals" });
  await expect(stats).toContainText("12 Logs");
  await expect(stats).toContainText("1.5 a Day");
  await p.context().close();
});

await c.check("previous month shows October's Logs; next comes back; no months after this one", async () => {
  await seedMonth();
  const p = await calendar();
  await expect(p.getByRole("button", { name: "Next month" })).toBeDisabled();
  await p.getByRole("button", { name: "Previous month" }).click();
  await expect(p.getByRole("heading", { name: "October 2026" })).toBeVisible();
  await expect(cell(p, "2026-10-20").locator(".count")).toHaveText("1");
  await expect(p.locator("[aria-current=date]")).toHaveCount(0);
  await expect(p.getByRole("region", { name: "Month totals" })).toContainText("1 Log");
  await p.getByRole("button", { name: "Next month" }).click();
  await expect(p.getByRole("heading", { name: "November 2026" })).toBeVisible();
  await expect(cell(p, "2026-11-06").locator(".count")).toHaveText("5");
  await p.context().close();
});

await c.check("tapping a Day lists its Logs with times (Log zone) and Details", async () => {
  await seedMonth();
  const p = await calendar();
  await cell(p, "2026-11-08").click();
  const sheet = p.getByRole("dialog", { name: /8/ });
  await expect(sheet.getByRole("listitem")).toHaveCount(1);
  const item = sheet.getByRole("listitem", { name: "Log at 09:15" });
  for (const t of ["4 Smooth", "12 min", "Urgent", "after coffee"]) await expect(item).toContainText(t);
  await shot(p, "phone-day-sheet");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await cell(p, "2026-11-06").click();
  await expect(p.getByRole("dialog").getByRole("listitem")).toHaveCount(5);
  await expect(p.getByRole("dialog").getByRole("listitem").first()).toHaveAccessibleName("Log at 06:00");
  await p.context().close();
});

await c.check("edit and delete from the Day sheet update the grid and totals", async () => {
  await seedMonth();
  const p = await calendar();
  await cell(p, "2026-11-07").click();
  const sheet = p.getByRole("dialog");
  await sheet.getByRole("button", { name: "Edit Log at 07:00" }).click();
  const editor = p.getByRole("dialog", { name: "Log details" });
  await editor.getByRole("radio", { name: /6 Mushy/ }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(sheet.getByRole("listitem", { name: "Log at 07:00" })).toContainText("6 Mushy");
  await sheet.getByRole("button", { name: "Delete Log at 11:00" }).click();
  await sheet.getByRole("listitem", { name: "Log at 11:00" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sheet.getByRole("listitem")).toHaveCount(2);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(cell(p, "2026-11-07").locator(".count")).toHaveText("2");
  await expect(cell(p, "2026-11-07")).toHaveAttribute("data-heat", "2");
  await expect(p.getByRole("region", { name: "Month totals" })).toContainText("11 Logs");
  await p.context().close();
});

await c.check("a Day older than the 7-day edit window offers delete but not edit", async () => {
  await seedMonth();
  const p = await calendar();
  await p.getByRole("button", { name: "Previous month" }).click();
  await cell(p, "2026-10-20").click();
  const sheet = p.getByRole("dialog");
  await expect(sheet.getByRole("listitem")).toHaveCount(1);
  await expect(sheet.getByRole("button", { name: /^Edit Log/ })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /^Delete Log/ })).toHaveCount(1);
  await p.context().close();
});

await c.check("coming back to the app (focus) refreshes the month with Logs made elsewhere", async () => {
  await seedMonth();
  const p = await calendar();
  await expect(cell(p, "2026-11-02").locator(".count")).toHaveText("1");
  await seed("2026-11-02T18:00:00Z"); // from another device
  setServerClock(CLOCK);
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(cell(p, "2026-11-02").locator(".count")).toHaveText("2");
  await p.context().close();
});

await c.check("pull-to-refresh at the top of the Calendar reloads the month", async () => {
  await seedMonth();
  const p = await calendar();
  await seed("2026-11-03T18:00:00Z");
  setServerClock(CLOCK);
  await expect(cell(p, "2026-11-03").locator(".count")).toHaveText("");
  const cdp = await p.context().newCDPSession(p);
  const box = (await p.getByRole("heading", { name: "November 2026" }).boundingBox())!;
  const x = box.x + box.width / 2;
  const touch = (type: string, y?: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: y === undefined ? [] : [{ x, y }] });
  await touch("touchStart", box.y);
  for (let d = 20; d <= 140; d += 20) await touch("touchMove", box.y + d);
  await touch("touchEnd");
  await expect(cell(p, "2026-11-03").locator(".count")).toHaveText("1");
  await p.context().close();
});

await c.check("screenshots: dark phone and desktop Calendar", async () => {
  await seedMonth();
  const dark = await calendar({ dark: true });
  await expect(cell(dark, "2026-11-06").locator(".count")).toHaveText("5");
  await shot(dark, "phone-calendar-dark");
  await cell(dark, "2026-11-08").click();
  await shot(dark, "phone-day-sheet-dark");
  await dark.context().close();
  const desk = await calendar({ device: "desktop" });
  await expect(cell(desk, "2026-11-06").locator(".count")).toHaveText("5");
  await shot(desk, "desktop-calendar");
  await desk.context().close();
});

c.report();
await app.close();
