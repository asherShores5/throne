// The Log details sheet: change the time (up to 7 days back), Duration, Bristol type, Note and Flags.
// Used for a Log just made (the "Add details" expander) and for editing one later (ticket 05's Day
// sheet can open it too).
import { useState } from "react";
import { BRISTOL_TYPES, FLAGS, NOTE_MAX, addDays, dayOf, type Flag } from "@throne/shared";
import type { Log } from "../../api/log";
import { editLog } from "../../sync/logs";
import { applyPending } from "../../sync/pending";
import { BristolIcon } from "./BristolIcon";
import { editFor, formFor, type LogForm } from "./form";

const FLAG_LABELS: Record<Flag, string> = { urgent: "Urgent", pain: "Pain", blood: "Blood", constipated: "Constipated", diarrhea: "Diarrhea" };

/** Saving goes through the outbox (sync/logs.ts): the edit shows at once and syncs when it can. */
export function LogEditor({ log, onSaved, onClose }: { log: Log; onSaved: (l: Log) => void; onClose: () => void }) {
  const [f, setF] = useState<LogForm>(() => formFor(log));
  const [error, setError] = useState<string>();
  const set = (patch: Partial<LogForm>) => setF((x) => ({ ...x, ...patch }));
  const today = dayOf(Date.now(), log.logZone);
  const noteLength = [...f.note.trim()].length;

  function save() {
    const r = editFor(log, f);
    if (!r.ok) return setError(r.error);
    setError(undefined);
    // A Log outside the outbox's loaded Days (e.g. opened from the Calendar) still shows the edit.
    onSaved(editLog(r.edit) ?? applyPending([log], [{ seq: 0, type: "update", log: r.edit }])[0]!);
  }

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="log-details-title">
        <h2 id="log-details-title">Log details</h2>
        <form noValidate onSubmit={(e) => (e.preventDefault(), save())} className="log-form">
          <div className="row">
            <label>
              Date
              <input type="date" value={f.day} min={addDays(today, -7)} max={today} onChange={(e) => set({ day: e.target.value })} />
            </label>
            <label>
              Time
              <input type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} />
            </label>
          </div>
          <label>
            Duration (minutes)
            <input type="number" inputMode="numeric" min={1} max={180} value={f.duration} onChange={(e) => set({ duration: e.target.value })} />
          </label>
          <fieldset>
            <legend>Bristol type</legend>
            <div className="bristol" role="radiogroup" aria-label="Bristol type">
              {BRISTOL_TYPES.map((b) => (
                <button
                  key={b.type} type="button" role="radio" aria-checked={f.bristolType === b.type}
                  onClick={() => set({ bristolType: f.bristolType === b.type ? undefined : b.type })}
                >
                  <BristolIcon type={b.type} />
                  <span className="num">{b.type}</span>
                  <span className="lbl">{b.label}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Flags</legend>
            <div className="flags">
              {FLAGS.map((fl) => (
                <button
                  key={fl} type="button" aria-pressed={f.flags.includes(fl)}
                  onClick={() => set({ flags: f.flags.includes(fl) ? f.flags.filter((x) => x !== fl) : [...f.flags, fl] })}
                >
                  {FLAG_LABELS[fl]}
                </button>
              ))}
            </div>
          </fieldset>
          <label>
            Note
            <textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} />
            <span className={`hint${noteLength > NOTE_MAX ? " over" : ""}`}>{noteLength}/{NOTE_MAX}</span>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const flagLabel = (f: Flag) => FLAG_LABELS[f];
