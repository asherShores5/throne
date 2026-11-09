// The caller's weekly Summaries (schema/summary.graphql, ticket 10). Read only; online only.
import type { AwardKind } from "@throne/shared";
import { gql } from "./gql";
import { SUMMARY } from "./selections";

export interface SummaryPerson {
  id: string;
  me: boolean;
  displayName: string;
  emoji: string;
  color: string;
  total: number;
  dailyAverage: number;
  change: number;
  bristolType: number | null;
}

export interface Summary {
  weekStart: string;
  weekEnd: string;
  people: SummaryPerson[];
  awards: { award: AwardKind; winners: string[] }[];
}

/** Newest first. */
export async function loadSummaries(): Promise<Summary[]> {
  return (await gql<{ summaries: Summary[] }>(`query Summaries { summaries { ${SUMMARY} } }`)).summaries;
}
