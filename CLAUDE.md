## Agent skills (this repo overrides /workplace/shoresaj/CLAUDE.md)

Personal project in a public repo. Don't use Taskei, builder-mcp or any Amazon tool here,
and never put Amazon-internal content in files or commits. Keep AWS account IDs, hosted zone IDs,
secrets and passwords out of tracked files.

### Issue tracker

Local files. One ticket per file in `.scratch/<milestone>/issues/NN-<slug>.md` (gitignored),
numbered in dependency order. Blocking edges go in each file's "Blocked by" line. Close a ticket
by setting its `Status:` line to `done`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`) go in each ticket's `Status:` line.

### Domain docs

Single context: `GLOSSARY.md` and `docs/adr/` at the repo root. Specs live in `docs/specs/`
(current: `docs/specs/2026-11-08-v1.md`). Use the GLOSSARY terms (Profile, Log, Details, Day,
Friend, Friendship, Friend request, Friend code, Invite, Reaction, Comment, Summary, Award) in
code and UI.

## Working rules

- Commit locally; push and open PRs only when Asher says. Once `main` and `prod` exist on GitHub
  they are protected; work lands by branch -> PR -> `main`, and a release is a PR `main` -> `prod`.
- A `prod` deploy waits in the GitHub `production` Environment for Asher's approval. Never
  approve it on his behalf; give him the run link.
- Commit as `asher.shores5@gmail.com` (set in this repo's git config).
- Live AWS changes (deploys, deleting data or DNS records) need Asher's explicit go each time.
- Stack mirrors `../honeydo` and `../nutrisage` (TS workspaces shared/api/web/infra + schema,
  CDK, AppSync + one Lambda, DynamoDB, Cognito, PWA, us-west-1). Reuse their patterns before
  inventing new ones. Pin `AWS_REGION=us-west-1 AWS_DEFAULT_REGION=us-west-1` before synth/diff.

## Commands (repo root)

- `npm install` once (workspaces). `e2e/` is not a workspace: `cd e2e && npm install && npx playwright install chromium`.
- `npm test`: vitest in shared, api, web and infra.
- `npm run typecheck`: tsc in every workspace (web also checks the service worker).
- `npm run build:web`: typecheck + Vite build to `web/dist` (needed by e2e and by a hosted synth).
- `npm run synth`: `cdk synth`. Pin the region first:
  `AWS_REGION=us-west-1 AWS_DEFAULT_REGION=us-west-1 npm run synth` (the dev desktop sets
  AWS_REGION=us-west-2 globally). Needs no AWS credentials; with no hosting config it builds only the app stack.
- e2e (after `build:web`): `cd e2e && npx tsx smoke.ts`. Screenshots go to `/tmp/e2e-throne-<checkout folder>/`.
  Look at them; passing DOM checks miss layout bugs. See `e2e/README.md`.

## Layout (built so tickets can work in parallel)

- `shared/src/`: pure domain logic, one file per area (`profile.ts`: Avatar choices, Home zone check,
  new-Profile defaults, Display name/Avatar checks; `invite.ts`: token format, 7-day life, cap of 3, link;
  `signUp.ts`: username/password form rules; `log.ts`: Details rules, time rules, Day from instant + Log zone and back, Log sort keys; `calendar.ts`: heat levels, Monday-first month grid, month range, Day counts, monthly total + daily average; `friend.ts`: Friend code alphabet/format/parse, cap of 3, 10 sends a rolling day; `push.ts`: push prefs defaults/edits, the push-service endpoint allowlist + 10-device cap, the PushEvent the API hands the Notifier, push text (`eventPushPayload`, no Details) and tap links (`pushLinks`); `calendar.ts` also has `combinedColors`: a clashing Avatar color gets an alternate shade plus the emoji), each re-exported from `index.ts`. New pure logic (Day bucketing, heat levels,
  Summary math, Awards, Friend codes, limits) goes here with a vitest test.
- `schema/`: the GraphQL schema split per entity. `base.graphql` declares `Query` and `Mutation`; each
  `<entity>.graphql` adds fields with `extend type Query/Mutation { ... }`. `schema/compose.ts` merges them
  for AppSync and the e2e backend (a root type with no fields yet is left out) and owns `QUERY_DEPTH_LIMIT`
  and `queryDepth()`. Use `#` comments, not `"descriptions"` (a schema test enforces it).
- `api/src/`: `handler.ts` (caller = Cognito `sub`, then dispatch by field name), `table.ts` (key layout,
  document client seam), `resolvers/<entity>.ts` (one `ResolverModule` per entity, merged in
  `resolvers/index.ts`). `resolvers/profile.ts` has `ensureProfile(ctx, zone)`, which later resolvers can
  call to get the caller's Profile (it also moves the Home zone with the device unless the Profile pinned one;
  `updateProfile` edits it). `resolvers/invite.ts`: Invites at `INVITE#<token>` / `INVITE`, held in 3 places per
  Profile (`INVITESLOT#1-3`, claimed in a transaction, so the cap holds under races). `preSignUp.ts`: the Cognito
  pre-sign-up trigger (its own Lambda) that spends an open Invite with one conditional write. `resolvers/log.ts`: Logs at `LOG#<Day>#<instant>#<id>` (a month of one
  Profile is one key range, `myLogs(from, to)`; a Friend's the same way via `friendLogs(friend, from, to)` behind `requireFriend`), plus `LOGID#<id>` (id lookup + idempotent create) and
  `LOGDAY#<Day>` (count for the 50-a-Day cap), always written together in one transaction. `clock.ts`: server
  time for the time rules (seam for e2e). `resolvers/friend.ts`: Friend codes (`FRIENDCODE#<code>` lookup plus
  the Profile's `FRIENDCODE` pointer), Friend requests (`FRIENDREQ#IN#<from>` under the receiver and
  `FRIENDREQ#OUT#<to>` under the sender, written together), Friendships (`FRIEND#<other>` under each side plus a
  `FRIENDCOUNT` per Profile; one transaction keeps both at 3 or fewer), the daily send limit (`FRIENDSENDS`).
  **Every read of another Profile's data goes through `isFriend(caller, other)` or
  `requireFriend(ctx, other, notFound)`** (one GetItem in the caller's partition; a non-Friend gets the same
  error as "not found"); also `friendIds(sub)` and `profileCard(sub)` (Display name + Avatar).
  `resolvers/reaction.ts`: Reactions and Comments live ON the Log item (`reactions` {author: emoji},
  `comments` [...], counter `rv`), so Log reads bring them, edits move them and deleting the Log deletes them;
  `out(rec, viewer)` in `log.ts` filters them (owner: all; anyone else: only their own; shared
  `visibleResponses`). Plus `RESPFROM#<author>#<logId>` in the owner's partition, so `endFriendship` can
  `clearResponses` both ways (it runs even when the Friendship is already over, so a retry finishes a half-done
  cleanup). Each change is one transaction: Log Update conditioned on `rv`, the pointer, and a ConditionCheck on
  the author's `FRIEND#<owner>` item.
  `resolvers/push.ts` (ticket 09): `pushPrefs` toggles on the Profile record (absent = Summary on, rest off),
  "Friend logged" as `notifyLogs` on my `FRIEND#<other>` item (so ending a Friendship unfollows), devices at
  `PUSH#<deviceId>`. `events.ts`: `emit(PushEvent)` after a write commits = async Lambda invoke of the Notifier
  (ids only; never fails the write; no `NOTIFIER_FUNCTION` = no-op). `notifier.ts`: its own Lambda (CJS for
  web-push): re-checks the Friendship/request, applies prefs, sends to every device, prunes 404/410;
  `runScheduled()` is where ticket 10's hourly Summary goes. `vapid.ts` + `vapidKeysProvider.ts`: the VAPID
  key custom resource (SSM `/throne/vapid/*`, never overwritten).
- `api/src/testing/`: `harness.ts` (call the real handler as Profiles `A`-`D` against the fake table; it also
  captures push events, `h.deliver()` runs the real Notifier on them with a fake push service, `h.takePushes()`) and
  `fakeDynamo.ts` (in-memory document client: conditional writes, all-or-nothing transactions, and it
  refuses un-aliased attribute names and unused placeholders).
- `infra/lib/`: `stacks.ts` (AppStack: table, Cognito, AppSync + Lambda, budget), `hosting.ts` (CertStack,
  WebStack: S3 + CloudFront with the CSP from `csp.ts`), `ci.ts` (CiStack: the GitHub OIDC deploy role),
  `config.ts` (zone/account from context or env), `app.ts` (wires them; Cert/Web/Ci only with hosting
  config). An AppSync resolver is created for every Query/Mutation field in the composed schema, so a new
  field needs only its schema line and its resolver. The Lambda gets Get/Put/Update/Delete/Query on the
  table and `lambda:InvokeFunction` on the Notifier only, no SSM (asserted in `infra/test/stacks.test.ts`). The
  Notifier gets Get/Query/Delete on the table and `ssm:GetParameter` on the two VAPID parameters; its async
  invokes are never retried. `config.json` gets `vapidPublicKey` from the VapidKeys resource.
- `web/src/`: `auth.ts` (Cognito JSON API: password, passkeys, refresh), `config.ts` (runtime `/config.json`),
  `api/gql.ts` (one call; `NetworkError` for anything retryable), `api/<entity>.ts` (GraphQL calls),
  `route.ts` (paths `/`, `/calendar` (also `?who=<sub>&day=<Day>` from a push), `/friends`, `/settings`, `/invite#<token>`; `useSearch`), `views/` (`Login`, `Home`, `Join` = Invite landing
  page, `Settings`, `AvatarPicker`, styles in `views/profile.css`; `views/log/`: the Log button + Undo toast, recent list, `LogEditor` details sheet; `views/calendar/`: `Calendar` (the Avatar row: Me, each Friend, Everyone; shown once there's a Friend), `MonthCalendar` (one person's heat month, or the combined grid with a count per person in Avatar colors from shared `combinedColors`), `monthLogs.ts` (`useMonthLogs`: my Logs from the outbox store via `refreshLogs`/`useLogs`, so pending ones show; a Friend's via `friendLogs`, never cached; one range query per person), `MonthGrid` (cell content from a `day()` callback), `DaySheet` (one group per person; only my Logs editable; Reactions/Comments under each Log via `log/Responses.tsx`, online only, and a Day marker when there are some), `refresh.ts` (focus + pull-to-refresh)). `views/friends/`: `FriendsPanel` (Friend code, Add a Friend, requests, Friends list with an inline end-Friendship confirmation; online only, not in the outbox). Home has three tabs: `/` Log, `/calendar` Calendar, `/friends` Friends. `sync/`: the offline outbox for Logs (`outbox.ts` pure queue: in order, folds edits/deletes into a create still on the device, drops refused writes; `pending.ts` pure: server copy + queue = what shows, refusal messages; `logs.ts` glue: localStorage per username, retry every 20 s, flush on open/online/focus/visible; `profileCache.ts`: last Profile so Home opens offline). `sw/sw.ts` + `src/swShell.ts`: the hand-rolled service worker built by
  `vite.config.ts`; it also shows pushes and opens their link (`src/deepLink.ts`: `notificationFor`, `clickPlan`,
  the `navigate` message App.tsx follows; no imports, the worker build takes plain modules). Push glue:
  `notifications.ts` (enable inside the click handler, disable, sign-out `releaseThisDevice`), pure `push.ts`,
  `pushDevice.ts`, `timeout.ts` (from HoneyDo); `views/Notifications.tsx` is the Settings section. Light/dark follow the phone (`prefers-color-scheme` in `styles.css`). Icons:
  `web/brand/icon.svg` is the source for the PNGs in `web/public/`.
- `e2e/`: Playwright against an in-process fake backend (`backend.ts`: the real handler on the fake table,
  fake Cognito, AppSync's depth cap, `setServerClock`), launcher `app.ts`, helpers `lib.ts`, checks per area
  (`smoke.ts`, `log.ts`, `invites.ts`, `calendar.ts`, `offline.ts`, `friends.ts`, `friendsCalendar.ts`, `reactions.ts`, `push.ts`; `open(u, { serviceWorkers: true, fakePush: true })` gives a stand-in push service); fake Cognito `SignUp` runs the real pre-sign-up trigger.
  The app is served with the deployed CSP (`infra/lib/csp.ts`); any CSP violation fails the run.

## Gotchas that will bite you

- **Identity is the Cognito `sub`** (`Ctx.sub`). Never read a Profile ID for the caller from arguments.
  Partitions are `PROFILE#<sub>`; the Profile record is `PROFILE#<sub>` / `PROFILE`.
- **Alias every attribute name** in every DynamoDB expression (`#status`, `#pk`, ...). The fake throws on a
  bare name or an unused `#name`/`:value`; live DynamoDB would throw on reserved words.
- **`QUERY_DEPTH_LIMIT` is the deepest real selection** (`me > avatar > emoji` and
  `myLogs > reactions > author` = 3 now; the Log selection lives in `web/src/api/selections.ts` so the test can
  import it). A ticket that sends a deeper one raises it and updates the pinned test in
  `infra/test/stacks.test.ts`; e2e refuses deeper queries.
- **Never write a Log item without the `rv` condition** (`sameResponses`/`unchangedSince` in `resolvers/log.ts`):
  a blind Put or Delete would wipe a Reaction or Comment that landed after the read (or leave its pointer).
- **The handler reads env at import time**: tests and e2e import it through `api/src/testing/harness.ts` /
  `e2e/backend.ts`, which set the env first. Never import it statically in a test.
- **Self sign-up is on only because of the Invite pre-sign-up trigger** (`api/src/preSignUp.ts`); never remove
  or weaken the trigger while self sign-up is on (one test in `infra/test/stacks.test.ts` asserts both). The
  trigger gets only `TABLE_NAME` and `UpdateItem` (a pool ID in its env would be a circular dependency).
  Visitors can't call the API, so the Invite landing page only learns a link is spent when sign-up is refused.
  It checks the form before calling SignUp, because a refused SignUp may still have spent the Invite.
- **Log writes go through `web/src/sync/logs.ts`** (`logNow`/`editLog`/`removeLog`/`useLogs`), never straight
  to `api/log.ts`, or they won't work offline or show as pending. The server's answer to a queued write comes
  later, so rules a form can check (Details, time) are checked before queueing (`views/log/form.ts`); only
  what the server alone knows (7 days old on arrival, the 50-a-Day cap) comes back as a notice. A reload
  that started before a write was confirmed is thrown away and re-run (else it wipes the new Log).
- **Health data**: never log arguments, results, Notes or Details (handler logs only error name/message;
  AppSync logs errors without content).
- **Time**: server rules use `now()` from `api/src/clock.ts`, never `Date.now()` directly. An e2e check that
  fakes the page clock (`open(u, { clock })`) must also call `setServerClock` with the same start, or the
  server judges "future" and "7 days old" by the real clock. A Log's Day is fixed by its own Log zone; never
  re-bucket Logs by the current Home zone.
- **Push text never carries Details, Comment text or Reaction emoji**: build it in shared `eventPushPayload`
  from the event kind + a Display name only. Emit an event only after the write commits and only when
  something changed (a retry or no-op emits nothing). The API Lambda must never get SSM access.
- **Passkeys**: the relying party is `APP_DOMAIN` (`throne.ashershores.com`), so passkeys only work there,
  and changing it orphans every passkey.
