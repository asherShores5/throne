// GraphQL selections the app sends, kept free of imports so infra/test/stacks.test.ts can pin
// QUERY_DEPTH_LIMIT to the deepest of them.

/** A Log with its Reactions and Comments. Depth 3 under a root field (myLogs > reactions > author). */
export const LOG = `id instant logZone day duration bristolType note flags reactions { author emoji } comments { id author text at }`;

/** A weekly Summary. Depth 3 under a root field (summaries > people > total); the Avatar is flat (emoji, color). */
export const SUMMARY = `weekStart weekEnd people { id me displayName emoji color total dailyAverage change bristolType } awards { award winners }`;
