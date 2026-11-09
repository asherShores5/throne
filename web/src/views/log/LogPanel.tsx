// The home screen's Log area: one big button that saves a Log for right now, a toast with Undo and
// "Add details" for a few seconds, and the last 7 days of Logs (the edit window) to edit or delete.
// Offline queueing is ticket 04 (the outbox); here a failed save just says so.
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, dayOf, localTime } from "@throne/shared";
import { createLog, deleteLog, errorText, myLogs, newLogId, type Log } from "../../api/log";
import { LogEditor } from "./LogEditor";
import { LogList } from "./LogList";
import "./log.css";

/** How long Undo stays on screen. */
export const UNDO_MS = 6000;

export function LogPanel({ homeZone }: { homeZone: string }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ log?: Log; text: string }>();
  const [editing, setEditing] = useState<Log>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const today = dayOf(Date.now(), homeZone);

  const refresh = useCallback(() => {
    const t = dayOf(Date.now(), homeZone);
    // The edit window (7 days back) plus tomorrow (a Log a few minutes ahead can land there).
    myLogs(addDays(t, -7), addDays(t, 1)).then(setLogs, (e) => setError(errorText(e)));
  }, [homeZone]);
  useEffect(refresh, [refresh]);

  const showToast = (t: { log?: Log; text: string }, ms = UNDO_MS) => {
    clearTimeout(timer.current);
    setToast(t);
    timer.current = setTimeout(() => setToast(undefined), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const upsert = (l: Log) => setLogs((xs) => [...xs.filter((x) => x.id !== l.id), l]);
  const drop = (id: string) => setLogs((xs) => xs.filter((x) => x.id !== id));

  async function logNow() {
    setSaving(true);
    setError(undefined);
    try {
      const l = await createLog({ id: newLogId(), instant: new Date().toISOString() });
      upsert(l);
      showToast({ log: l, text: `Logged at ${localTime(Date.parse(l.instant), l.logZone)}.` });
    } catch (e) {
      setError(`Couldn't save: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(l: Log, undo = false) {
    try {
      await deleteLog(l.id);
      drop(l.id);
      showToast({ text: undo ? "Log undone." : "Log deleted." }, 2500);
    } catch (e) {
      setError(`Couldn't delete: ${errorText(e)}`);
    }
  }

  return (
    <div className="log-panel">
      <button type="button" className="log-button" aria-label="Log now" disabled={saving} onClick={() => void logNow()}>
        <span aria-hidden="true">Log</span>
      </button>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast.text}</span>
            {toast.log && (
              <>
                <button type="button" className="link" onClick={() => { clearTimeout(timer.current); setEditing(toast.log); setToast(undefined); }}>Add details</button>
                <button type="button" className="link" onClick={() => { const l = toast.log!; setToast(undefined); void remove(l, true); }}>Undo</button>
              </>
            )}
          </div>
        )}
      </div>

      <section aria-label="Recent Logs" className="recent">
        {logs.length ? (
          <LogList logs={logs} today={today} onEdit={setEditing} onDelete={(l) => remove(l)} />
        ) : (
          <p className="hint">No Logs in the last 7 days.</p>
        )}
      </section>

      {editing && (
        <LogEditor
          log={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(l) => { upsert(l); setEditing(undefined); showToast({ text: "Saved." }, 2500); }}
        />
      )}
    </div>
  );
}
