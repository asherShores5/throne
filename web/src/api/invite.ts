// Invites (schema/invite.graphql). The link puts the token after # (shared/src/invite.ts).
import { inviteLink } from "@throne/shared";
import { gql } from "./gql";

export interface Invite {
  token: string;
  createdAt: string;
  expiresAt: string;
}

const INVITE = `token createdAt expiresAt`;

/** The link to share for an Invite, on this app's own origin. */
export const linkFor = (inv: Invite) => inviteLink(location.origin, inv.token);

export async function listInvites(): Promise<Invite[]> {
  return (await gql<{ invites: Invite[] }>(`query Invites { invites { ${INVITE} } }`)).invites;
}

export async function createInvite(): Promise<Invite> {
  return (await gql<{ createInvite: Invite }>(`mutation CreateInvite { createInvite { ${INVITE} } }`)).createInvite;
}

export async function revokeInvite(token: string): Promise<void> {
  await gql(`mutation RevokeInvite($token: ID!) { revokeInvite(token: $token) }`, { token });
}
