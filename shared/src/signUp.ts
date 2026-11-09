// Sign-up form rules, checked in the browser before Cognito's SignUp call so a typo can't spend an
// Invite (the pre-sign-up trigger may run before Cognito refuses the request for another reason).
// The password rule mirrors the user pool's policy in infra/lib/stacks.ts.

export const PASSWORD_MIN = 16;

/** The sign-in username: trimmed, lowercased (sign-in is case-insensitive), 3 to 32 of a-z 0-9 . _ - */
export function cleanUsername(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  const t = u.trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(t) ? t : undefined;
}

/** What's wrong with a new password, in words, or undefined if the pool will take it. */
export function passwordProblem(p: string): string | undefined {
  if (p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (!/[a-z]/.test(p)) return "Add a lowercase letter.";
  if (!/[A-Z]/.test(p)) return "Add an uppercase letter.";
  if (!/[0-9]/.test(p)) return "Add a digit.";
  return undefined;
}
