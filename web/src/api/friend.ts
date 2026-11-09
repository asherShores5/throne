// Friends (schema/friend.graphql). Selections stay at depth 3 (friends > avatar > emoji).
import type { Avatar } from "@throne/shared";
import { gql } from "./gql";

export interface Friend {
  id: string;
  displayName: string;
  avatar: Avatar;
  since: string;
}

export interface FriendRequest {
  id: string;
  displayName: string;
  avatar: Avatar;
  sentAt: string;
}

export interface SentFriendRequest {
  /** Opaque: what cancel takes (never the receiver's Profile id). */
  id: string;
  code: string;
  sentAt: string;
}

export interface FriendsState {
  code: string;
  friends: Friend[];
  requests: FriendRequest[];
  sent: SentFriendRequest[];
}

const AVATAR = `avatar { emoji color }`;
const FRIEND = `id displayName ${AVATAR} since`;

/** Everything the Friends tab shows, in one call. */
export async function loadFriends(): Promise<FriendsState> {
  const r = await gql<{ myFriendCode: string; friends: Friend[]; friendRequests: FriendRequest[]; sentFriendRequests: SentFriendRequest[] }>(
    `query Friends {
      myFriendCode
      friends { ${FRIEND} }
      friendRequests { id displayName ${AVATAR} sentAt }
      sentFriendRequests { id code sentAt }
    }`,
  );
  return { code: r.myFriendCode, friends: r.friends, requests: r.friendRequests, sent: r.sentFriendRequests };
}

/** Just the Friends, oldest Friendship first (the Calendar's Avatar row). */
export async function listFriends(): Promise<Friend[]> {
  return (await gql<{ friends: Friend[] }>(`query FriendList { friends { ${FRIEND} } }`)).friends;
}

export async function regenerateFriendCode(): Promise<string> {
  return (await gql<{ regenerateFriendCode: string }>(`mutation Regenerate { regenerateFriendCode }`)).regenerateFriendCode;
}

/** "SENT" (waiting for them) or "FRIENDS" (they had already asked you). */
export async function sendFriendRequest(code: string): Promise<"SENT" | "FRIENDS"> {
  return (await gql<{ sendFriendRequest: "SENT" | "FRIENDS" }>(`mutation Send($code: String!) { sendFriendRequest(code: $code) }`, { code })).sendFriendRequest;
}

export async function acceptFriendRequest(from: string): Promise<Friend> {
  return (await gql<{ acceptFriendRequest: Friend }>(`mutation Accept($from: ID!) { acceptFriendRequest(from: $from) { ${FRIEND} } }`, { from })).acceptFriendRequest;
}

export async function declineFriendRequest(from: string): Promise<void> {
  await gql(`mutation Decline($from: ID!) { declineFriendRequest(from: $from) }`, { from });
}

export async function cancelFriendRequest(request: string): Promise<void> {
  await gql(`mutation Cancel($request: ID!) { cancelFriendRequest(request: $request) }`, { request });
}

export async function endFriendship(friend: string): Promise<void> {
  await gql(`mutation End($friend: ID!) { endFriendship(friend: $friend) }`, { friend });
}
