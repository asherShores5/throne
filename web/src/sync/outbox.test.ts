import { describe, expect, it } from "vitest";
import { NetworkError } from "../api/errors";
import { createOutbox, type Op } from "./outbox";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const label = (op: Op) => `${op.type}:${op.type === "delete" ? op.id : op.log.id}`;

/** A fake API: records what it was sent; `down` makes every send a NetworkError. */
function fakeApi() {
  const api = {
    sent: [] as string[],
    down: false,
    reject: undefined as undefined | ((op: Op) => Error | undefined),
    /** Resolves when the test lets this send through (to catch a send in flight). */
    hold: undefined as undefined | Promise<void>,
    async send(op: Op) {
      if (api.hold) await api.hold;
      if (api.down) throw new NetworkError("offline");
      const no = api.reject?.(op);
      if (no) throw no;
      api.sent.push(label(op));
      return undefined;
    },
  };
  return api;
}

function setup(stored: Op[] = []) {
  const api = fakeApi();
  let saved: Op[] = stored;
  const rejected: [Op, string][] = [];
  const box = createOutbox({
    load: () => saved,
    save: (ops) => void (saved = ops),
    send: (op) => api.send(op),
    onRejected: (op, e) => rejected.push([op, e.message]),
  });
  return { api, box, saved: () => saved, rejected };
}

const create = (id: string, instant = "2026-11-08T18:00:00.000Z") => ({ type: "create" as const, zone: "America/Los_Angeles", log: { id, instant, flags: [] } });

describe("outbox", () => {
  it("sends queued writes one at a time, oldest first", async () => {
    const { api, box } = setup();
    void box.enqueue(create(A));
    await box.enqueue(create(B));
    expect(api.sent).toEqual([`create:${A}`, `create:${B}`]);
    expect(box.pending()).toEqual([]);
  });

  it("keeps writes on the device while offline and sends them, in order, on the next flush", async () => {
    const { api, box, saved } = setup();
    api.down = true;
    await box.enqueue(create(A));
    await box.enqueue({ type: "update", log: { id: B, flags: ["pain"] } });
    expect(api.sent).toEqual([]);
    expect(saved().map((o) => o.type)).toEqual(["create", "update"]);
    api.down = false;
    await box.flush();
    expect(api.sent).toEqual([`create:${A}`, `update:${B}`]);
    expect(saved()).toEqual([]);
  });

  it("picks up writes saved by an earlier session (an app reload)", async () => {
    const first = setup();
    first.api.down = true;
    await first.box.enqueue(create(A));
    const second = setup(first.saved());
    await second.box.flush();
    expect(second.api.sent).toEqual([`create:${A}`]);
  });

  it("drops a write the server refuses, tells the caller, and carries on with the rest", async () => {
    const { api, box, rejected } = setup();
    api.down = true;
    await box.enqueue(create(A));
    await box.enqueue(create(B));
    api.down = false;
    api.reject = (op) => (op.type === "create" && op.log.id === A ? new Error("ValidationError: A Log can't be more than 7 days old.") : undefined);
    await box.flush();
    expect(rejected.map(([op, m]) => [op.type, m])).toEqual([["create", "ValidationError: A Log can't be more than 7 days old."]]);
    expect(api.sent).toEqual([`create:${B}`]);
    expect(box.pending()).toEqual([]);
  });

  it("when a create is refused, the queued edits and deletes of that Log go with it (they can't land)", async () => {
    const { api, box, rejected } = setup();
    let release!: () => void;
    api.hold = new Promise((r) => (release = r));
    api.reject = (op) => (op.type === "create" ? new Error("ValidationError: no") : undefined);
    const sending = box.enqueue(create(A)); // in flight, so the edit below queues behind it
    void box.enqueue({ type: "update", log: { id: A, flags: [] } });
    void box.enqueue({ type: "delete", id: A });
    release();
    await sending;
    expect(rejected).toHaveLength(1);
    expect(api.sent).toEqual([]);
    expect(box.pending()).toEqual([]);
  });

  it("keeps a write the server couldn't take right now (Unavailable) and stops, to try again later", async () => {
    const { api, box, rejected } = setup();
    let once = true;
    api.reject = () => (once ? ((once = false), new Error("Unavailable: That Log just changed. Try again.")) : undefined);
    await box.enqueue({ type: "delete", id: A });
    expect(rejected).toEqual([]);
    expect(box.pending()).toHaveLength(1);
    await box.flush();
    expect(api.sent).toEqual([`delete:${A}`]);
  });

  it("an edit of a Log still waiting to be created is folded into the create (time kept unless changed)", async () => {
    const { api, box } = setup();
    api.down = true;
    await box.enqueue(create(A, "2026-11-08T18:00:00.000Z"));
    await box.enqueue({ type: "update", log: { id: A, duration: 5, flags: ["urgent"] } });
    expect(box.pending()).toHaveLength(1);
    expect(box.pending()[0]).toMatchObject({ type: "create", log: { id: A, instant: "2026-11-08T18:00:00.000Z", duration: 5, flags: ["urgent"] } });
    await box.enqueue({ type: "update", log: { id: A, instant: "2026-11-08T17:00:00.000Z", flags: [] } });
    expect(box.pending()[0]).toMatchObject({ type: "create", log: { id: A, instant: "2026-11-08T17:00:00.000Z", flags: [] } });
    expect((box.pending()[0] as Extract<Op, { type: "create" }>).log.duration).toBeUndefined();
  });

  it("deleting a Log still waiting to be created (an offline Undo) just forgets it", async () => {
    const { api, box } = setup();
    api.down = true;
    await box.enqueue(create(A));
    await box.enqueue({ type: "update", log: { id: A, flags: [] } });
    await box.enqueue({ type: "delete", id: A });
    expect(box.pending()).toEqual([]);
    api.down = false;
    await box.flush();
    expect(api.sent).toEqual([]);
  });

  it("a create already on its way is not folded: the delete goes out after it", async () => {
    const { api, box } = setup();
    let release!: () => void;
    api.hold = new Promise((r) => (release = r));
    const sending = box.enqueue(create(A));
    void box.enqueue({ type: "delete", id: A });
    expect(box.pending().map((o) => o.type)).toEqual(["create", "delete"]);
    release();
    await sending;
    expect(api.sent).toEqual([`create:${A}`, `delete:${A}`]);
  });
});
