// The Log outbox: creates, edits and deletes of Logs saved on the device first, then sent to the API
// one at a time, oldest first (HoneyDo/NutriSage outbox pattern). Offline or on a weak signal the
// writes wait on the device and go out when the API answers again. Every Log id is made on the
// device, so a resend after a lost answer is the same Log (the server answers a repeated create with
// the Log it already has, and a repeated delete is a no-op): replays never duplicate.
//
// Pure: storage and the network are passed in, so tests drive it (outbox.test.ts).
import type { LogInput } from "../api/log";
import { NetworkError } from "../api/errors";

/** A create always carries its time, and the Home zone it was made in (for showing it before it lands). */
export type CreateInput = LogInput & { instant: string };

export type Op =
  | { seq: number; type: "create"; log: CreateInput; zone: string }
  | { seq: number; type: "update"; log: LogInput }
  | { seq: number; type: "delete"; id: string };
export type NewOp = Op extends infer O ? (O extends Op ? Omit<O, "seq"> : never) : never;

export const opLogId = (op: Op | NewOp) => (op.type === "delete" ? op.id : op.log.id);

/**
 * Whether a failed send should wait and go again later (kept at the head of the queue) rather than be
 * dropped as refused. No answer at all, or the server saying "busy, try again" (Unavailable: a Log
 * changed at the same moment elsewhere), waits; anything else the server said is final.
 */
export function shouldRetry(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  const name = (e as Error)?.name;
  // A Cognito refusal means the session is gone: keep the writes for when the Profile signs in again.
  if (name === "CognitoError") return true;
  return /^Unavailable: /.test(String((e as Error)?.message ?? ""));
}

export interface OutboxDeps {
  /** Ops saved on this device by an earlier session. */
  load(): Op[];
  save(ops: Op[]): void;
  /** Sends one op; resolves with the server's answer. */
  send(op: Op): Promise<unknown>;
  /** An op reached the server. */
  onSent?(op: Op, result: unknown): void;
  /** The server refused an op (e.g. a Log too old by the time it arrived). It and the rest of that Log's queued ops are dropped. */
  onRejected?(op: Op, error: Error): void;
  /** false when a send couldn't get through (it will be retried), true when one does. */
  onReachable?(reachable: boolean): void;
  /** Called whenever the queue changes (enqueue, sent, dropped). */
  onChange?(ops: Op[]): void;
}

export function createOutbox(deps: OutboxDeps) {
  let ops: Op[] = deps.load();
  let seq = ops.reduce((m, o) => Math.max(m, o.seq), 0);
  let flushing: Promise<void> | undefined;
  /** The op being sent right now: never folded into or removed by a newer write. */
  let inFlight: number | undefined;

  const set = (next: Op[]) => {
    ops = next;
    deps.save(ops);
    deps.onChange?.(ops);
  };

  async function run() {
    while (ops.length) {
      const op = ops[0];
      inFlight = op.seq;
      try {
        const result = await deps.send(op);
        inFlight = undefined;
        set(ops.filter((o) => o.seq !== op.seq));
        deps.onReachable?.(true);
        deps.onSent?.(op, result);
      } catch (e) {
        inFlight = undefined;
        if (shouldRetry(e)) {
          deps.onReachable?.(!(e instanceof NetworkError));
          return;
        }
        // A refused create means the Log never existed on the server, so its queued edits and
        // deletes can't land either.
        const id = opLogId(op);
        set(ops.filter((o) => o.seq !== op.seq && !(op.type === "create" && opLogId(o) === id)));
        deps.onReachable?.(true);
        deps.onRejected?.(op, e as Error);
      }
    }
  }

  /** Send everything queued, in order. One run at a time; resolves when empty or a send must wait. */
  function flush(): Promise<void> {
    flushing ??= run().finally(() => (flushing = undefined));
    return flushing;
  }

  /**
   * Fold a write into a create of the same Log that hasn't left the device yet, so the server only ever
   * sees the final Log: an edit becomes part of the create (an edit replaces every Detail; its time,
   * if given, replaces the create's), and a delete (an offline Undo) drops the create and its edits.
   * Returns the new queue, or undefined when there is nothing to fold into.
   */
  function fold(op: Op): Op[] | undefined {
    const id = opLogId(op);
    const i = ops.findIndex((o) => o.type === "create" && o.log.id === id && o.seq !== inFlight);
    if (i < 0 || op.type === "create") return undefined;
    if (op.type === "delete") return ops.filter((o) => opLogId(o) !== id);
    const c = ops[i] as Extract<Op, { type: "create" }>;
    const { instant, ...details } = op.log;
    const merged: Op = { ...c, log: { ...details, id, instant: instant ?? c.log.instant } };
    return ops.map((o, j) => (j === i ? merged : o));
  }

  return {
    /** Queue a write and try to send it. Resolves when the queue is empty or a send must wait. */
    enqueue(op: NewOp): Promise<void> {
      const full = { ...op, seq: ++seq } as Op;
      set(fold(full) ?? [...ops, full]);
      return flush();
    },
    flush,
    pending: () => ops,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
