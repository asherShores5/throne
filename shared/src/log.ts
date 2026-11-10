// Logs (GLOSSARY: Log, Log zone, Day, Details, Bristol type, Flag). Pure rules shared by the api (what it
// accepts and stores) and the web client (what it offers and shows). No I/O.

// ---- Details ----------------------------------------------------------------

export const DURATION_MIN = 1;
export const DURATION_MAX = 180;
export const NOTE_MAX = 200;

/** The fixed Flags, in the order they're shown and stored. */
export const FLAGS = ["urgent", "pain", "blood", "constipated", "diarrhea"] as const;
export type Flag = (typeof FLAGS)[number];

/** The Bristol stool scale, 1 to 7, with the short labels the app shows. */
export const BRISTOL_TYPES = [
  { type: 1, label: "Hard lumps" },
  { type: 2, label: "Lumpy" },
  { type: 3, label: "Cracked" },
  { type: 4, label: "Smooth" },
  { type: 5, label: "Soft blobs" },
  { type: 6, label: "Mushy" },
  { type: 7, label: "Liquid" },
] as const;

export interface Details {
  /** Minutes, 1-180. */
  duration?: number;
  /** 1-7. */
  bristolType?: number;
  /** Up to 200 characters, trimmed; never empty. */
  note?: string;
  /** A subset of FLAGS, in FLAGS order. */
  flags: Flag[];
}

export type Parsed<T> = { ok: true; details: T } | { ok: false; error: string };

const intIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Checks Details from a client. Absent or null means "not given". */
export function parseDetails(input: { duration?: unknown; bristolType?: unknown; note?: unknown; flags?: unknown }): Parsed<Details> {
  const out: Details = { flags: [] };
  const { duration, bristolType, note, flags } = input;
  if (duration != null) {
    if (!intIn(duration, DURATION_MIN, DURATION_MAX)) return { ok: false, error: `Duration is ${DURATION_MIN} to ${DURATION_MAX} minutes.` };
    out.duration = duration as number;
  }
  if (bristolType != null) {
    if (!intIn(bristolType, 1, 7)) return { ok: false, error: "Bristol type is 1 to 7." };
    out.bristolType = bristolType as number;
  }
  if (note != null) {
    if (typeof note !== "string") return { ok: false, error: "Note must be text." };
    const t = note.trim();
    if ([...t].length > NOTE_MAX) return { ok: false, error: `A Note is at most ${NOTE_MAX} characters.` };
    if (t) out.note = t;
  }
  if (flags != null) {
    if (!Array.isArray(flags) || flags.some((f) => !(FLAGS as readonly unknown[]).includes(f))) return { ok: false, error: `Flags are ${FLAGS.join(", ")}.` };
    if (new Set(flags).size !== flags.length) return { ok: false, error: "A Flag can only be set once." };
    out.flags = FLAGS.filter((f) => flags.includes(f));
  }
  return { ok: true, details: out };
}

// ---- Time rules ---------------------------------------------------------------

/** How far ahead of server time a Log may be (phone clock skew). */
export const FUTURE_SKEW_MS = 5 * 60_000;
/** How far back a Log may be made or moved, at the moment the server receives it. */
export const PAST_LIMIT_MS = 7 * 24 * 3_600_000;

/** The messages the server gives, so the client (and the offline outbox) can recognize them. */
export const LOG_TOO_NEW = "A Log can't be in the future.";
export const LOG_TOO_OLD = "A Log can't be more than 7 days old.";

/** undefined if `instant` is allowed at server time `now`, else the reason. */
export function checkLogTime(instant: number, now: number): string | undefined {
  if (instant > now + FUTURE_SKEW_MS) return LOG_TOO_NEW;
  if (instant < now - PAST_LIMIT_MS) return LOG_TOO_OLD;
  return undefined;
}

/** An ISO 8601 date-time with Z or an offset, as epoch ms; undefined for anything else. */
export function parseInstant(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

// ---- Days ---------------------------------------------------------------------

/** At most this many Logs per Profile per Day (protects cost, like HoneyDo's record caps). */
export const LOGS_PER_DAY_MAX = 50;

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(instant: number, zone: string) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, f);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(instant)) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The Day (YYYY-MM-DD) of an instant in a zone. A Log's Day uses its Log zone, fixed when it was made. */
export function dayOf(instant: number, zone: string): string {
  const p = partsIn(instant, zone);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** The time of day (HH:MM, 24h) of an instant in a zone. */
export function localTime(instant: number, zone: string): string {
  const p = partsIn(instant, zone);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** The zone's offset from UTC at an instant, in ms (local = UTC + offset). */
function offsetAt(instant: number, zone: string) {
  const p = partsIn(instant, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock Day + HH:MM happens in a zone. A time that happens twice (fall back) gives one
 * of them; a time that doesn't exist (spring forward) gives the same time read with the earlier offset,
 * which lands just after the gap.
 */
export function zonedInstant(day: string, time: string, zone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const first = wall - offsetAt(wall, zone);
  const second = wall - offsetAt(first, zone);
  return offsetAt(second, zone) === offsetAt(first, zone) ? second : first;
}

/** A real calendar date written YYYY-MM-DD. */
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The Day `n` Days after `day` (negative goes back). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---- Ids and keys -------------------------------------------------------------------

/** A Log id: a UUID made by the client (so a retried create is the same Log). */
export const isLogId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Where a Log sorts in its owner's partition: Day, then instant, then id (two Logs in the same ms).
 * So a month of one Profile's Logs is one key range (logSortKeyRange), in time order.
 */
export const logSortKey = (day: string, instant: number, id: string) => `LOG#${day}#${new Date(instant).toISOString()}#${id}`;

/** The inclusive sort-key range holding every Log on the Days from..to. */
export const logSortKeyRange = (from: string, to: string) => ({ from: `LOG#${from}#`, to: `LOG#${to}#￿` });
