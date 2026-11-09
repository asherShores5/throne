// The home screen's Log area: one big button that saves a Log for right now, a toast with Undo and
// "Add details" for a few seconds, and the last 7 days of Logs (the edit window) to edit or delete.
// Every write goes through the outbox (sync/logs.ts): it shows at once, works with no signal, and is
// marked "Waiting to sync" until the server has it.
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, dayOf, localTime } from "@throne/shared";
import { errorText, type Log } from "../../api/log";
import { dismissNotice, logNow as saveNow, refreshLogs, removeLog, useLogs } from "../../sync/logs";
import { LogEditor } from "./LogEditor";
import { LogList } from "./LogList";
import "./log.css";

/** How long Undo stays on screen. */
export const UNDO_MS = 6000;

export function LogPanel({ homeZone }: { homeZone: string }) {
  const { logs, notices, offline, waiting } = useLogs();
  const [toast, setToast] = useState<{ log?: Log; text: string }>();
  const [editing, setEditing] = useState<Log>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const today = dayOf(Date.now(), homeZone);

  const refresh = useCallback(() => {
    const t = dayOf(Date.now(), homeZone);
    // The edit window (7 days back) plus tomorrow (a Log a few minutes ahead can land there).
    refreshLogs(addDays(t, -7), addDays(t, 1)).catch((e) => setError(errorText(e)));
  }, [homeZone]);
  useEffect(refresh, [refresh]);

  const showToast = (t: { log?: Log; text: string }, ms = UNDO_MS) => {
    clearTimeout(timer.current);
    setToast(t);
    timer.current = setTimeout(() => setToast(undefined), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  function logNow() {
    setError(undefined);
    const l = saveNow(homeZone);
    showToast({ log: l, text: `Logged at ${localTime(Date.parse(l.instant), l.logZone)}.` });
  }

  async function remove(l: Log, undo = false) {
    removeLog(l.id);
    showToast({ text: undo ? "Log undone." : "Log deleted." }, 2500);
  }

  return (
    <div className="log-panel">
      <button type="button" className="log-button" aria-label="Log now" onClick={logNow}>
        <span aria-hidden="true">Log</span>
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {notices.map((n, i) => (
        <p key={i} className="error notice" role="alert">
          <span>{n}</span>
          <button type="button" className="link" onClick={() => dismissNotice(i)}>OK</button>
        </p>
      ))}
      {offline && waiting > 0 && (
        <p className="hint offline-note">Offline. {waiting === 1 ? "1 change" : `${waiting} changes`} will sync when you're back online.</p>
      )}

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
          onSaved={() => { setEditing(undefined); showToast({ text: "Saved." }, 2500); }}
        />
      )}
    </div>
  );
}
