// One GraphQL call to the Throne API with the signed-in Profile's ID token.
// Anything that means "no usable answer" (offline, a weak signal that times out, a 5xx, a token
// refresh that couldn't reach Cognito) is a NetworkError, so the outbox keeps the write and
// retries; a GraphQL error is the server saying no.
import { CognitoError, freshTokens } from "../auth";
import { getConfig } from "../config";
import { NetworkError } from "./errors";

let profileDeleted: (() => void) | undefined;
/** Who finishes a Delete Profile when the server says this Profile is deleted (account.ts). */
export function onProfileDeleted(fn: () => void) {
  profileDeleted = fn;
}

/** A weak signal counts as offline after this long, so a write waits in the outbox instead of hanging. */
const TIMEOUT_MS = 15_000;

export async function gql<T = any>(query: string, variables: object = {}): Promise<T> {
  let idToken: string;
  try {
    ({ idToken } = await freshTokens());
  } catch (e) {
    if (e instanceof CognitoError) throw e;
    throw new NetworkError("No connection. Try again when you're back online.");
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r: Response;
  let json: any;
  try {
    r = await fetch(getConfig().graphqlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: idToken },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
    json = await r.json().catch(() => ({}));
  } catch (e) {
    throw new NetworkError(ctl.signal.aborted ? "No answer from the server (weak signal?)." : "No connection. Try again when you're back online.");
  } finally {
    clearTimeout(timer);
  }
  if (json.errors?.length) {
    const message = json.errors.map((e: { message: string }) => e.message).join("; ");
    if (/(^|; )ProfileDeleted: /.test(message)) profileDeleted?.();
    throw new Error(message);
  }
  if (r.status >= 500) throw new NetworkError(`server ${r.status}`);
  if (!r.ok) throw new Error(`server ${r.status}`);
  return json.data as T;
}

