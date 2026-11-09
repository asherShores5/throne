// Copied from HoneyDo (ticket 09).
// Time limits for calls that can hang on a weak signal. Pure: no browser globals.

/**
 * Runs `run`, rejecting with `onTimeout()` if it hasn't settled within `ms`. The signal passed to
 * `run` is aborted on timeout, so a fetch given it stops too.
 */
export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(onTimeout());
    }, ms);
  });
  return Promise.race([run(ctl.signal), timeout]).finally(() => clearTimeout(timer));
}

/** `p`'s value, or undefined if it hasn't arrived within `ms`. Never rejects on timeout. */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
