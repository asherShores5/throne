// Loading a month of Logs for the people on the Calendar: me, one Friend, or everyone (up to 4, one range
// query each). My Logs come from the outbox store (sync/logs.ts), so ones made offline and not yet sent
// show too, marked pending; a Friend's come straight from friendLogs (read-only, never cached).
import { useCallback, useEffect, useRef, useState } from "react";
import { monthRange } from "@throne/shared";
import { NetworkError } from "../../api/errors";
import { errorText, friendLogs, type Log } from "../../api/log";
import { gotLog, refreshLogs, useLogs } from "../../sync/logs";
import type { ShownLog } from "../../sync/pending";

/** Whose Logs: `me`, or a Friend by their Profile id. */
export interface Whose {
  id: string;
  me?: boolean;
}

export interface MonthLogs {
  /** Each person's Logs in the month, by id. */
  logs: Record<string, ShownLog[]>;
  loading: boolean;
  error?: string;
  reload: () => void;
  /** Swap in the server's newer copy of one Log (after a Reaction or Comment change). */
  replace: (person: Whose, log: Log) => void;
}

export function useMonthLogs(month: string, people: readonly Whose[]): MonthLogs {
  const mine = useLogs().logs;
  const [theirs, setTheirs] = useState<Record<string, Log[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const seq = useRef(0);
  const { from, to } = monthRange(month);
  // Stable across renders while the same people are shown.
  const key = people.map((p) => (p.me ? "me" : p.id)).join(",");

  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    const who = key.split(",");
    Promise.allSettled(
      who.map((id) => (id === "me" ? refreshLogs(from, to).then(() => undefined) : friendLogs(id, from, to).then((xs) => [id, xs] as const))),
    ).then((rs) => {
      if (n !== seq.current) return;
      const got: Record<string, Log[]> = {};
      const lost: string[] = [];
      let failed: unknown;
      rs.forEach((r, i) => {
        if (r.status === "fulfilled") {
          if (r.value) got[r.value[0]] = r.value[1];
        } else {
          failed ??= r.reason;
          // No longer a Friend (or gone): drop what was shown of them. Offline keeps the last copy.
          if (who[i] !== "me" && !(r.reason instanceof NetworkError)) lost.push(who[i]);
        }
      });
      setTheirs((old) => {
        const next = { ...old, ...got };
        for (const id of lost) delete next[id];
        return next;
      });
      setError(failed === undefined ? undefined : `Couldn't load: ${errorText(failed as Error)}`);
      setLoading(false);
    });
  }, [key, from, to]);
  useEffect(reload, [reload]);

  const logs: Record<string, ShownLog[]> = {};
  for (const p of people) {
    const all = p.me ? mine : theirs[p.id] ?? [];
    logs[p.id] = all.filter((l) => l.day >= from && l.day <= to);
  }
  const replace = useCallback((person: Whose, log: Log) => {
    if (person.me) return gotLog(log);
    setTheirs((old) => (old[person.id] ? { ...old, [person.id]: old[person.id].map((l) => (l.id === log.id ? log : l)) } : old));
  }, []);
  return { logs, loading, error, reload, replace };
}
