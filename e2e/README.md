# Browser checks (fake backend)

Headless Chromium (iPhone 13 profile, Pacific time) runs the built app with every network call
routed in-process: the real API handler on the in-memory table (`api/src/testing/fakeDynamo.ts`)
behind a GraphQL executor built from the composed `schema/*.graphql` (with AppSync's query depth
cap), and a fake Cognito (password `e2e-password`). Users are `sam`, `alex`, `jo` and `max`.
Nothing touches AWS. Copied from NutriSage's e2e harness.

Not a workspace, so CI never installs it.

    npm run build:web          # repo root
    cd e2e && npm install && npx playwright install chromium
    npx tsx smoke.ts           # walking skeleton: invite-only sign-in page, password sign-in, home screen, Profile created once, CSP, sign out
    npx tsx invites.ts         # Invite link in Settings, sign-up via the link (real pre-sign-up trigger), passkey, bad/used/revoked links, cap, Settings edits
    npx tsx log.ts             # one-tap Log: tap, Undo toast, details sheet, edit (move Day), delete
    npx tsx calendar.ts        # My Calendar: month grid, heat, prev/next, totals, Day sheet, focus + pull-to-refresh
    npx tsx offline.ts         # offline outbox: pending marker, reload offline, replay in order, lost answer, too old on arrival
    npx tsx friends.ts         # Friends: Friend code, send by code (not found, any case), accept/decline/cancel, auto-accept, regenerate, end Friendship

Screenshots go to `/tmp/e2e-throne-<checkout folder>/` (override with `E2E_OUT`), so parallel
worktrees don't overwrite each other. Add a new check script per feature area using `checklist()`
from `lib.ts`. Look at the screenshots: passing DOM checks miss layout bugs.

Not covered: real device passkeys (Face ID, iCloud Keychain, phone QR), iOS install quirks. Service
workers are blocked unless a check opts in (`open(user, { serviceWorkers: true })`; `setOffline(page, on)`
takes a page off the network). This dev desktop has no emoji font, so Avatars render blank in
screenshots here; check them on a phone.
