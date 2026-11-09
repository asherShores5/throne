// Reactions and Comments (ticket 08). Schema: schema/reaction.graphql; rules: shared/src/reaction.ts.
// They live on the Log item they answer (attributes `reactions` {author: emoji}, `comments` [..], and the
// counter `rv`, see resolvers/log.ts), so a Log read brings them along, a Log edit moves them, and deleting
// the Log deletes them. Two more things per (author, Log), in the Log owner's partition:
//   PROFILE#<owner> / RESPFROM#<author>#<logId>   {}: the author has something on that Log
// so ending a Friendship finds everything one side left on the other's Logs with one key range.
//
// Every change is one transaction: the Log item (conditioned on `rv`, so racing changes never lose one),
// the pointer, and (for a Friend) a check that the Friendship still exists, so nothing lands after it ends.
//
// Who sees what is decided here, not by the client: the owner gets every Reaction and Comment on their Logs,
// anyone else only their own (out() in resolvers/log.ts).
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  COMMENTS_PER_LOG_MAX, hasResponsesFrom, isLogId, isReactionEmoji, parseCommentText, withoutAuthor, type Comment, type PushEvent, type Responses,
} from "@throne/shared";
import { now } from "../clock";
import { emit } from "../events";
import { UserError, invalid } from "../errors";
import { TABLE, ddb, profilePk } from "../table";
import { FRIEND_PREFIX, requireFriend } from "./friend";
import { RESPONSE_POINTER_PREFIX, out, read, responsePointerSk, sameResponses, type Log } from "./log";
import type { Ctx, ResolverModule } from "./types";

const noLog = () => new UserError("NotFound", "No such Log.");
/** Tries before giving up when other changes keep landing between our read and our write. */
const TRIES = 5;

type Change = (r: Required<Responses>, rec: Record<string, unknown>) => Required<Responses>;

function current(rec: Record<string, unknown>): Required<Responses> {
  return { reactions: (rec.reactions as Record<string, string> | undefined) ?? {}, comments: (rec.comments as Comment[] | undefined) ?? [] };
}

const same = (a: Required<Responses>, b: Required<Responses>) => JSON.stringify(a) === JSON.stringify(b);

function cancelled(e: unknown) {
  return (e as { name?: string })?.name === "TransactionCanceledException";
}

/**
 * One write of a Log's Reactions/Comments plus the pointer for `author` (put while they still have something
 * there, else deleted). `friendOf`: also require that this Profile is still the owner's Friend.
 */
function writeItems(owner: string, rec: Record<string, unknown>, next: Required<Responses>, author: string, friendOf?: string) {
  const pk = profilePk(owner);
  const cond = sameResponses(rec);
  const logId = rec.id as string;
  const pointer = { PK: pk, SK: responsePointerSk(author, logId) };
  return [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: pk, SK: rec.SK },
        UpdateExpression: "SET #reactions = :reactions, #comments = :comments, #rv = :next",
        ConditionExpression: `attribute_exists(#pk) AND ${cond.expr}`,
        ExpressionAttributeNames: { "#pk": "PK", "#rv": "rv", "#reactions": "reactions", "#comments": "comments" },
        ExpressionAttributeValues: { ...cond.values, ":reactions": next.reactions, ":comments": next.comments, ":next": ((rec.rv as number) ?? 0) + 1 },
      },
    },
    hasResponsesFrom(next, author) ? { Put: { TableName: TABLE, Item: pointer } } : { Delete: { TableName: TABLE, Key: pointer } },
    ...(friendOf
      ? [{
          ConditionCheck: {
            TableName: TABLE, Key: { PK: profilePk(friendOf), SK: `${FRIEND_PREFIX}${owner}` },
            ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" },
          },
        }]
      : []),
  ];
}

/**
 * Read the Log, apply `change`, write it back; again from the top if something else changed it in between.
 * `author` is whose pointer the change affects; `friendOf` as in writeItems. `tell`: the push event for the
 * owner, handed to the Notifier once the write has committed (never when nothing changed, e.g. a retry).
 */
async function change(
  ctx: Ctx, owner: string, logId: string, author: (rec: Record<string, unknown>) => string | undefined, fn: Change, friendOf?: string,
  tell?: (rec: Record<string, unknown>) => PushEvent,
): Promise<Log> {
  for (let i = 0; i < TRIES; i++) {
    const rec = await read(profilePk(owner), logId);
    if (!rec) throw noLog();
    const before = current(rec);
    const next = fn(before, rec);
    const who = author(rec);
    if (!who || same(before, next)) return out(rec, ctx.sub);
    try {
      await ddb().send(new TransactWriteCommand({ TransactItems: writeItems(owner, rec, next, who, friendOf) }));
      if (tell) await emit(tell(rec));
      return out({ ...rec, ...next, rv: ((rec.rv as number) ?? 0) + 1 }, ctx.sub);
    } catch (e) {
      if (!cancelled(e)) throw e;
      // The Friendship ended in between: from now on they're a stranger.
      if (friendOf) await requireFriend(ctx, owner, noLog);
      // Otherwise the Log changed (another Reaction, an edit, a delete): read it again.
    }
  }
  throw new UserError("Unavailable", "That Log just changed. Try again.");
}

/** The owner and Log ids from the arguments; junk is "no such Log" like anything else not found. */
function ids(args: Record<string, unknown>): { owner: string; logId: string } {
  const { owner, log } = args;
  if (typeof owner !== "string" || !owner || owner.length > 128 || !isLogId(log)) throw noLog();
  return { owner, logId: log.toLowerCase() };
}

/** For a write by a Friend: the owner must be the caller's Friend now (yourself isn't), checked before anything else. */
async function asFriend(ctx: Ctx, args: Record<string, unknown>) {
  const { owner, logId } = ids(args);
  await requireFriend(ctx, owner, noLog);
  return { owner, logId };
}

async function setReaction(ctx: Ctx, args: Record<string, unknown>): Promise<Log> {
  const { owner, logId } = await asFriend(ctx, args);
  const emoji = args.emoji ?? null;
  if (emoji !== null && !isReactionEmoji(emoji)) throw invalid("That isn't one of the Reactions.");
  return change(ctx, owner, logId, () => ctx.sub, (r) => {
    const { [ctx.sub]: _old, ...others } = r.reactions;
    return { ...r, reactions: emoji === null ? others : { ...others, [ctx.sub]: emoji } };
  }, ctx.sub, emoji === null ? undefined : (rec) => ({ kind: "reaction", to: owner, from: ctx.sub, logId, day: rec.day as string }));
}

async function addComment(ctx: Ctx, args: Record<string, unknown>): Promise<Log> {
  const { owner, logId } = await asFriend(ctx, args);
  if (!isLogId(args.id)) throw invalid("A Comment id is a UUID.");
  const commentId = args.id.toLowerCase();
  const parsed = parseCommentText(args.text);
  if (!parsed.ok) throw invalid(parsed.error);
  return change(ctx, owner, logId, () => ctx.sub, (r) => {
    if (r.comments.some((c) => c.id === commentId)) return r; // a retry: it's already there
    if (r.comments.length >= COMMENTS_PER_LOG_MAX) throw invalid(`${COMMENTS_PER_LOG_MAX} Comments on a Log is the limit.`);
    return { ...r, comments: [...r.comments, { id: commentId, author: ctx.sub, text: parsed.text, at: new Date(now()).toISOString() }] };
  }, ctx.sub, (rec) => ({ kind: "comment", to: owner, from: ctx.sub, logId, day: rec.day as string }));
}

async function deleteComment(ctx: Ctx, args: Record<string, unknown>): Promise<Log> {
  const { owner, logId } = ids(args);
  const mine = owner === ctx.sub;
  if (!mine) await requireFriend(ctx, owner, noLog);
  const commentId = typeof args.id === "string" ? args.id.toLowerCase() : "";
  // The owner may delete any Comment on their Log; anyone else only their own (someone else's is left be,
  // as if it weren't there: they can't see it).
  const target = (rec: Record<string, unknown>) => current(rec).comments.find((c) => c.id === commentId && (mine || c.author === ctx.sub));
  return change(
    ctx, owner, logId,
    (rec) => target(rec)?.author,
    (r, rec) => {
      const gone = target(rec);
      return gone ? { ...r, comments: r.comments.filter((c) => c.id !== gone.id) } : r;
    },
    mine ? undefined : ctx.sub,
  );
}

/**
 * Delete everything `author` left on `owner`'s Logs (an ended Friendship). Safe to run again, and to run
 * when there's nothing: each pointer goes in the same write that clears its Log.
 */
export async function clearResponses(owner: string, author: string): Promise<void> {
  const pk = profilePk(owner);
  const prefix = `${RESPONSE_POINTER_PREFIX}${author}#`;
  const logIds: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
        ExpressionAttributeValues: { ":pk": pk, ":p": prefix },
        ExclusiveStartKey: start,
      }),
    );
    logIds.push(...(r.Items ?? []).map((i) => String(i.SK).slice(prefix.length)));
    start = r.LastEvaluatedKey;
  } while (start);

  for (const logId of logIds) {
    for (let i = 0; ; i++) {
      const rec = await read(pk, logId);
      try {
        if (!rec) {
          // The Log is gone; only a stray pointer could be left.
          await ddb().send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: TABLE, Key: { PK: pk, SK: responsePointerSk(author, logId) } } }] }));
        } else {
          await ddb().send(new TransactWriteCommand({ TransactItems: writeItems(owner, rec, withoutAuthor(rec, author), author) }));
        }
        break;
      } catch (e) {
        if (!cancelled(e) || i + 1 >= TRIES) throw e; // the Log changed in between: again
      }
    }
  }
}

export const reaction: ResolverModule = {
  Query: {},
  Mutation: { setReaction, addComment, deleteComment },
};
