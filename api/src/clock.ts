// Server time for the time rules. Production reads the real clock; e2e/backend.ts points it at the page's
// faked clock so a check's "now" is the same on both sides. (Unit tests use vitest's fake timers instead.)
let clock: () => number = () => Date.now();

/** Now, in epoch ms. */
export const now = () => clock();

/** Test seam: replace the clock. Production never calls this. */
export function setClock(c: () => number) {
  clock = c;
}
