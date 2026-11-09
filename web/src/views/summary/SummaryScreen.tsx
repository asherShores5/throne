import "../profile.css";
import "./summary.css";
import { useEffect, useState } from "react";
import { loadSummaries, type Summary } from "../../api/summary";
import { plainMessage } from "../../api/profile";
import { onLink } from "../../route";
import { SummaryCard } from "./SummaryCard";

const FIRST_ONE = "Your first Summary comes on Monday morning.";

/** The latest Summary as a small card on Home (Log tab), with a way to the full list. Hidden if it can't load. */
export function LatestSummaryCard() {
  const [list, setList] = useState<Summary[]>();
  useEffect(() => {
    loadSummaries().then(setList, () => setList(undefined));
  }, []);
  if (!list) return null;
  if (!list.length) return <p className="hint summary-first">{FIRST_ONE}</p>;
  return (
    <div className="latest-summary">
      <SummaryCard summary={list[0]} compact title="Latest Summary" />
      <a className="link" href="/summary" onClick={onLink("/summary")}>See the full Summary and past weeks ›</a>
    </div>
  );
}

/** /summary (a Summary push opens it): the latest Summary in full, then the past ones, newest first. */
export function SummaryScreen() {
  const [list, setList] = useState<Summary[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    loadSummaries().then(setList, (e) => setError(plainMessage(e)));
  }, []);
  const [latest, ...past] = list ?? [];
  return (
    <main className="settings summary-screen">
      <header className="topbar">
        <a className="link" href="/" onClick={onLink("/")}>‹ Throne</a>
        <h1>Summary</h1>
        <span className="topbar-spacer" />
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!list ? (
        !error && <p className="center">Loading…</p>
      ) : !latest ? (
        <p className="center">{FIRST_ONE}</p>
      ) : (
        <>
          <SummaryCard summary={latest} title="Latest Summary" />
          {past.length > 0 && (
            <>
              <h2 className="section">Past Summaries</h2>
              {past.map((s) => <SummaryCard key={s.weekStart} summary={s} />)}
            </>
          )}
        </>
      )}
    </main>
  );
}
