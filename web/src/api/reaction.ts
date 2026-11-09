// Reactions and Comments (schema/reaction.graphql). Online only, like Friend actions: not in the outbox.
// Each answers with the Log as the caller may see it, so the screen can swap it in.
import { LOG, clean, type Log } from "./log";
import { gql } from "./gql";

/** Put `emoji` (or null: take it off) as my Reaction on a Friend's Log. */
export async function setReaction(owner: string, log: string, emoji: string | null): Promise<Log> {
  const r = await gql<{ setReaction: Log }>(
    `mutation React($owner: ID!, $log: ID!, $emoji: String) { setReaction(owner: $owner, log: $log, emoji: $emoji) { ${LOG} } }`,
    { owner, log, emoji },
  );
  return clean(r.setReaction);
}

/** Write a Comment on a Friend's Log. The id is made here, so a retry adds it once. */
export async function addComment(owner: string, log: string, text: string, id = crypto.randomUUID()): Promise<Log> {
  const r = await gql<{ addComment: Log }>(
    `mutation Comment($owner: ID!, $log: ID!, $id: ID!, $text: String!) { addComment(owner: $owner, log: $log, id: $id, text: $text) { ${LOG} } }`,
    { owner, log, id, text },
  );
  return clean(r.addComment);
}

/** Delete a Comment (my own, or any on my own Log). */
export async function deleteComment(owner: string, log: string, id: string): Promise<Log> {
  const r = await gql<{ deleteComment: Log }>(
    `mutation Uncomment($owner: ID!, $log: ID!, $id: ID!) { deleteComment(owner: $owner, log: $log, id: $id) { ${LOG} } }`,
    { owner, log, id },
  );
  return clean(r.deleteComment);
}
