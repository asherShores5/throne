// GraphQL selections the app sends, kept free of imports so infra/test/stacks.test.ts can pin
// QUERY_DEPTH_LIMIT to the deepest of them.

/** A Log with its Reactions and Comments. Depth 3 under a root field (myLogs > reactions > author). */
export const LOG = `id instant logZone day duration bristolType note flags reactions { author emoji } comments { id author text at }`;
