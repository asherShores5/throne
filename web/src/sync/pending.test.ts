import { describe, expect, it } from "vitest";
import type { Log } from "../api/log";
import type { Op } from "./outbox";
import { applyPending, refusedText } from "./pending";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const LA = "America/Los_Angeles";

const server: Log = { id: A, instant: "2026-11-08T18:00:00.000Z", logZone: LA, day: "2026-11-08", duration: 4, flags: [], reactions: [], comments: [] };
const R = { reactions: [{ author: "sub-b", emoji: "👏" }], comments: [{ id: B, author: "sub-b", text: "hi", at: "2026-11-08T19:00:00.000Z" }] };

describe("applyPending", () => {
  it("shows the server's Logs as they are when nothing is waiting", () => {
    expect(applyPending([server], [])).toEqual([server]);
  });

  it("shows a Log waiting to be created, on its Day in the zone it was made in, marked pending", () => {
    // 01:30 UTC on the 9th is still the 8th in Los Angeles.
    const ops: Op[] = [{ seq: 1, type: "create", zone: LA, log: { id: B, instant: "2026-11-09T01:30:00.000Z", bristolType: 4, flags: ["urgent"] } }];
    expect(applyPending([], ops)).toEqual([
      { id: B, instant: "2026-11-09T01:30:00.000Z", logZone: LA, day: "2026-11-08", bristolType: 4, flags: ["urgent"], reactions: [], comments: [], pending: true },
    ]);
  });

  it("shows a waiting edit over the server's copy: Details replaced, time kept unless moved, Day from the Log's own zone", () => {
    const keep: Op[] = [{ seq: 1, type: "update", log: { id: A, note: "ok", flags: ["pain"] } }];
    expect(applyPending([server], keep)).toEqual([{ id: A, instant: server.instant, logZone: LA, day: "2026-11-08", note: "ok", flags: ["pain"], reactions: [], comments: [], pending: true }]);
    const moved: Op[] = [{ seq: 1, type: "update", log: { id: A, instant: "2026-11-07T07:30:00.000Z", flags: [] } }];
    expect(applyPending([server], moved)[0]).toMatchObject({ instant: "2026-11-07T07:30:00.000Z", day: "2026-11-06", pending: true });
  });

  it("a waiting edit keeps the Log's Reactions and Comments", () => {
    const ops: Op[] = [{ seq: 1, type: "update", log: { id: A, instant: "2026-11-07T07:30:00.000Z", flags: [] } }];
    expect(applyPending([{ ...server, ...R }], ops)[0]).toMatchObject({ ...R, day: "2026-11-06", pending: true });
  });

  it("hides a Log with a waiting delete, and ignores an edit of a Log it doesn't have", () => {
    expect(applyPending([server], [{ seq: 1, type: "delete", id: A }])).toEqual([]);
    expect(applyPending([], [{ seq: 1, type: "update", log: { id: A, flags: [] } }])).toEqual([]);
  });

  it("a create the server already has (its answer was lost) shows once, still pending", () => {
    const ops: Op[] = [{ seq: 1, type: "create", zone: LA, log: { id: A, instant: server.instant, flags: [] } }];
    const shown = applyPending([server], ops);
    expect(shown).toHaveLength(1);
    expect(shown[0].pending).toBe(true);
  });
});

describe("refusedText", () => {
  it("says plainly that a Log too old on arrival wasn't saved, with its Day and time", () => {
    const op: Op = { seq: 1, type: "create", zone: LA, log: { id: A, instant: "2026-10-30T17:05:00.000Z", flags: [] } };
    expect(refusedText(op, new Error("ValidationError: A Log can't be more than 7 days old."))).toBe(
      "Your Log from 2026-10-30 at 10:05 reached the server more than 7 days later, so it wasn't saved.",
    );
  });

  it("names the write and the server's reason for anything else", () => {
    expect(refusedText({ seq: 1, type: "update", log: { id: A, flags: [] } }, new Error("NotFound: No such Log."))).toBe("A Log edit couldn't be saved: No such Log.");
    expect(refusedText({ seq: 1, type: "delete", id: A }, new Error("Forbidden: no"))).toBe("A Log delete couldn't be saved: no");
  });
});
