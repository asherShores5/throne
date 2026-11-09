// The signed-in Profile's Logs on this device: the last copy loaded from the API (kept in localStorage)
// plus the outbox of creates, edits and deletes not yet confirmed (outbox.ts). Screens read through
// useLogs() and write through logNow/editLog/removeLog, which change the screen at once and are saved
// on the device before anything is sent, so logging works with no signal and survives a reload.
//
// - Opening the app, coming back to it (visible or focused) and going back online send the outbox,
//   then reload the Logs, so writes from other devices show up.
// - After a send that couldn't get through, it tries again every RETRY_MS while writes are waiting
//   (the "online" event alone misses a weak signal).
// - A write the server refuses (e.g. a Log more than 7 days old by the time it arrives) is dropped
//   and a notice says so (pending.ts refusedText).
// - Each Profile's copy and outbox are kept under its own username, so signing in as someone else on
//   the same device never shows or sends another Profile's Logs.
import { useSyncExternalStore } from "react";
import { currentUsername, onAuthChange } from "../auth";
import { NetworkError } from "../api/errors";
import { createLog, deleteLog, myLogs, newLogId, updateLog, type Log, type LogInput } from "../api/log";
import { createOutbox, type Op, type Outbox } from "./outbox";
import { applyPending, refusedText, type ShownLog } from "./pending";

const CACHE = "throne.logs.v1:";
const OUTBOX = "throne.outbox.v1:";
/** After a failed send, try again this often while writes are waiting. */
export const RETRY_MS = 20_000;

export interface LogsView {
  logs: ShownLog[];
  /** Messages about writes the server refused, oldest first. */
  notices: string[];
  /** The last send couldn't reach the server (shown as "offline" while writes are waiting). */
  offline: boolean;
  /** Writes waiting on this device. */
  waiting: number;
}

function readJSON<T>(key: string): T | undefined {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
function writeJSON(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Storage full or blocked: the copy in memory still works for this session.
  }
}

let user: string | undefined;
let server: Log[] = [];
let notices: string[] = [];
let offline = false;
let outbox: Outbox | undefined;
let view: LogsView = { logs: [], notices: [], offline: false, waiting: 0 };
let retry: ReturnType<typeof setTimeout> | undefined;
/** Writes confirmed by the server so far: a reload that started before one landed is stale. */
let confirmed = 0;
/** The Days the screen last asked for, reloaded on resume. */
let shownDays: { from: string; to: string } | undefined;

const listeners = new Set<() => void>();
function emit() {
  const ops = outbox?.pending() ?? [];
  view = { logs: applyPending(server, ops), notices, offline, waiting: ops.length };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

function setServer(next: Log[]) {
  server = next;
  if (user) writeJSON(CACHE + user, server);
}

function send(op: Op): Promise<unknown> {
  if (op.type === "create") return createLog(op.log);
  if (op.type === "update") return updateLog(op.log);
  return deleteLog(op.id);
}

/** Load (or switch to) the signed-in Profile's copy and outbox. */
function switchUser() {
  const u = currentUsername();
  if (u === user && outbox) return;
  clearTimeout(retry);
  user = u;
  server = (u && readJSON<Log[]>(CACHE + u)) || [];
  notices = [];
  offline = false;
  outbox = !u
    ? undefined
    : createOutbox({
        load: () => readJSON<Op[]>(OUTBOX + u) ?? [],
        save: (ops) => writeJSON(OUTBOX + u, ops),
        send,
        onChange: emit,
        onSent: (op, result) => {
          confirmed++;
          if (op.type === "delete") setServer(server.filter((l) => l.id !== op.id));
          else setServer([...server.filter((l) => l.id !== op.log.id), result as Log]);
          emit();
        },
        onRejected: (op, e) => {
          notices = [...notices, refusedText(op, e)];
          emit();
        },
        onReachable: (r) => {
          if (offline === !r) return;
          offline = !r;
          emit();
        },
      });
  emit();
}

/** Send what's waiting; if some must wait, try again in a while. */
async function flush() {
  const box = outbox;
  if (!box) return;
  clearTimeout(retry);
  await box.flush();
  if (box === outbox && box.pending().length) retry = setTimeout(() => void flush(), RETRY_MS);
}

/** Send the outbox, then reload the Days the screen shows. */
async function resume() {
  await flush();
  if (shownDays) await refreshLogs(shownDays.from, shownDays.to).catch(() => {});
}

let started = false;
/** Once per page: follow sign-in changes and send the outbox whenever the app comes back. */
function start() {
  if (started) return;
  started = true;
  switchUser();
  onAuthChange(() => {
    switchUser();
    void flush();
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void resume());
  globalThis.addEventListener("focus", () => void resume());
  globalThis.addEventListener("online", () => void resume());
  void flush();
}

/** The Logs on screen: the server's copy with waiting writes applied (pending ones marked). */
export function useLogs(): LogsView {
  start();
  return useSyncExternalStore(subscribe, () => view);
}

/**
 * Reload the Logs on the Days from..to (the outbox goes first, so the reload already has them). Offline,
 * the copy on the device stays and this resolves quietly; any other failure rejects.
 */
export async function refreshLogs(from: string, to: string): Promise<void> {
  start();
  const want = (shownDays = { from, to });
  const u = user;
  await flush();
  try {
    // A write confirmed while the reload was on its way may be missing from its answer: ask again.
    for (let tries = 0; tries < 3; tries++) {
      const seen = confirmed;
      const logs = await myLogs(from, to);
      // Signed out, or the screen moved on (e.g. another month) while this was on its way.
      if (u !== user || want !== shownDays) return;
      if (seen !== confirmed) continue;
      setServer(logs);
      emit();
      return;
    }
  } catch (e) {
    if (e instanceof NetworkError) return;
    throw e;
  }
}

function shown(id: string): ShownLog | undefined {
  return view.logs.find((l) => l.id === id);
}

/** Save a Log for right now, made in `zone` (the Home zone). Shows at once; sent when possible. */
export function logNow(zone: string): ShownLog {
  start();
  const log = { id: newLogId(), instant: new Date().toISOString(), flags: [] };
  void outbox?.enqueue({ type: "create", log, zone }).then(scheduleRetry);
  return shown(log.id)!;
}

/** Save an edit (every Detail; the time if moved). Returns the Log as it now shows. */
export function editLog(edit: LogInput): ShownLog | undefined {
  start();
  void outbox?.enqueue({ type: "update", log: edit }).then(scheduleRetry);
  return shown(edit.id);
}

export function removeLog(id: string): void {
  start();
  void outbox?.enqueue({ type: "delete", id }).then(scheduleRetry);
}

function scheduleRetry() {
  clearTimeout(retry);
  if (outbox?.pending().length) retry = setTimeout(() => void flush(), RETRY_MS);
}

export function dismissNotice(i: number) {
  notices = notices.filter((_, j) => j !== i);
  emit();
}
