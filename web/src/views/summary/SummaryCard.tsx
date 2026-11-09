import "./summary.css";
import { AWARD_NAMES, BRISTOL_TYPES, formatAverage } from "@throne/shared";
import type { Summary, SummaryPerson } from "../../api/summary";

const AWARD_EMOJI = { mostRegular: "⏱️", earlyBird: "🌅", nightOwl: "🦉", streak: "🔥" } as const;

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** "Nov 2 – 8" style label for a Summary's Monday-Sunday week. */
export function weekLabel(s: Pick<Summary, "weekStart" | "weekEnd">): string {
  return dayFmt.formatRange(asDate(s.weekStart), asDate(s.weekEnd));
}

function change(n: number) {
  if (n === 0) return "same as the week before";
  return `${n > 0 ? "▲" : "▼"} ${Math.abs(n)} vs the week before`;
}

const bristolLabel = (t: number | null) => (t == null ? undefined : `Mostly type ${t} (${BRISTOL_TYPES[t - 1]?.label ?? "?"})`);

function Person({ p, compact }: { p: SummaryPerson; compact: boolean }) {
  return (
    <li className="summary-person">
      <span className="avatar" style={{ background: p.color }} role="img" aria-label={`${p.displayName}'s Avatar`}>{p.emoji}</span>
      <div className="summary-numbers">
        <span className="name">{p.me ? `${p.displayName} (you)` : p.displayName}</span>
        {!compact && (
          <span className="hint">
            {formatAverage(p.dailyAverage)} a Day · {change(p.change)}
            {bristolLabel(p.bristolType) && <> · {bristolLabel(p.bristolType)}</>}
          </span>
        )}
      </div>
      <span className="summary-total" aria-label={`${p.total} Logs`}>{p.total}</span>
    </li>
  );
}

/**
 * One weekly Summary: each person's total (the recipient first), and in full also the daily average,
 * the change from the week before, the most common Bristol type; then the Awards. `compact` is the Home card.
 */
export function SummaryCard({ summary, compact = false, title }: { summary: Summary; compact?: boolean; title?: string }) {
  const names = new Map(summary.people.map((p) => [p.id, p.me ? "You" : p.displayName]));
  return (
    <section className="card summary" aria-label={`Summary for ${weekLabel(summary)}`}>
      <h2>{title ?? weekLabel(summary)}</h2>
      {title && <p className="hint">{weekLabel(summary)}</p>}
      <ul className="summary-people">
        {summary.people.map((p) => <Person key={p.id} p={p} compact={compact} />)}
      </ul>
      {summary.awards.length > 0 && (
        <ul className="awards" aria-label="Awards">
          {summary.awards.map((a) => (
            <li key={a.award}>
              <span aria-hidden="true">{AWARD_EMOJI[a.award]}</span> <strong>{AWARD_NAMES[a.award]}</strong>:{" "}
              {a.winners.map((w) => names.get(w) ?? "someone").join(" & ")}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
