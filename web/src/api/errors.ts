// Errors the API client throws, so the outbox can tell "try again later" from "the server said no".

/** The request never got a usable answer (offline, weak signal, timeout, 5xx). Safe to retry. */
export class NetworkError extends Error {
  readonly name = "NetworkError";
}

/** The server's "<Type>: message" error, without the type, for showing to the Profile. */
export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^(ValidationError|NotFound|Forbidden|Unavailable|ProfileDeleted): /, "");
