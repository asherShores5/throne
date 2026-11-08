// Errors the API client throws, so the outbox can tell "try again later" from "the server said no".

/** The request never got a usable answer (offline, weak signal, timeout, 5xx). Safe to retry. */
export class NetworkError extends Error {
  readonly name = "NetworkError";
}
