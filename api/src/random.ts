// Randomness for server defaults (a new Profile's Avatar color). Production uses Math.random; the test
// harness and e2e/backend.ts pin it so expectations stay fixed.
let random: () => number = Math.random;

/** A number in [0, 1). */
export const rand = () => random();

/** Test seam: replace the source. Production never calls this. */
export function setRandom(r: () => number) {
  random = r;
}
