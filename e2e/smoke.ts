// Walking skeleton (ticket 01): the sign-in page says Throne is invite-only; signing in with a password
// lands on the (empty) home screen and creates the Profile once, with the device's zone; sign out.
import { expect } from "playwright/test";
import { CSP, TIME_ZONE, cspViolations, launch } from "./app";
import { PASSWORD, db } from "./backend";
import { checklist, lastCall, shot } from "./lib";

const app = await launch();
const c = checklist("smoke");

await c.check("the sign-in page says Throne is invite-only and has no sign-up form", async () => {
  const p = await app.open("sam", { signedOut: true });
  c.watch(p);
  await expect(p.getByRole("heading", { name: "Throne" })).toBeVisible();
  await expect(p.getByText("Throne is invite-only.")).toBeVisible();
  await expect(p.getByRole("button", { name: /sign up|create/i })).toHaveCount(0);
  await shot(p, "phone-sign-in");
  await p.context().close();
});

await c.check("signs in with a password and sees the home screen; the Profile is created with this device's zone", async () => {
  const p = await app.open("sam", { signedOut: true });
  c.watch(p);
  await p.getByLabel("Username").fill("Sam");
  await p.getByRole("button", { name: "Use password instead" }).click();
  await p.getByLabel("Password").fill("wrong-password");
  await p.getByRole("button", { name: "Sign in with password" }).click();
  await expect(p.getByRole("alert")).toHaveText("Incorrect username or password.");
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in with password" }).click();
  await expect(p.getByRole("region", { name: "Home" })).toBeVisible();
  await expect(p.getByText("Hi, New Profile.")).toBeVisible();
  await expect(p.getByRole("img", { name: "New Profile's Avatar" })).toBeVisible();
  expect((lastCall("me")?.args as { homeZone?: string })?.homeZone).toBe(TIME_ZONE);
  const profiles = db.dump().filter((r) => r.SK === "PROFILE");
  expect(profiles.map((r) => [r.PK, r.homeZone])).toEqual([["PROFILE#sub-sam", TIME_ZONE]]);
  await shot(p, "phone-home");
  await p.context().close();
});

await c.check("opening the app again finds the same Profile (no second record)", async () => {
  const p = await app.open("sam");
  c.watch(p);
  await expect(p.getByText("Hi, New Profile.")).toBeVisible();
  expect(db.dump().filter((r) => r.SK === "PROFILE")).toHaveLength(1);
  await p.context().close();
});

await c.check("runs under the deployed Content-Security-Policy (inline script and outside hosts are blocked)", async () => {
  const p = await app.open("sam");
  c.watch(p);
  const res = await p.reload();
  if (res?.headers()["content-security-policy"] !== CSP) throw new Error("the app wasn't served with the CSP");
  await expect(p.getByRole("region", { name: "Home" })).toBeVisible();
  const before = cspViolations.length;
  const inline = () => { const s = document.createElement("script"); s.textContent = "window.__ran = 1"; document.head.appendChild(s); return (window as any).__ran ? "ran" : "blocked"; };
  expect(await p.evaluate(inline)).toBe("blocked");
  expect(await p.evaluate(() => fetch("https://example.com/").then(() => "sent", () => "blocked"))).toBe("blocked");
  await expect.poll(() => cspViolations.length).toBeGreaterThanOrEqual(before + 2);
  cspViolations.splice(before); // these two were on purpose
  await p.context().close();
});

await c.check("dark mode follows the phone; desktop layout", async () => {
  const dark = await app.open("sam", { dark: true });
  c.watch(dark);
  await expect(dark.getByRole("region", { name: "Home" })).toBeVisible();
  await shot(dark, "phone-home-dark");
  await dark.context().close();
  const desk = await app.open("sam", { device: "desktop" });
  c.watch(desk);
  await expect(desk.getByRole("region", { name: "Home" })).toBeVisible();
  await shot(desk, "desktop-home");
  await desk.context().close();
});

await c.check("signs out back to the sign-in screen", async () => {
  const p = await app.open("sam");
  c.watch(p);
  await p.getByRole("button", { name: "Sign out" }).click();
  await expect(p.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  await p.context().close();
});

c.report();
await app.close();
