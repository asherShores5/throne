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
  Look at them; passing DOM checks miss layout bugs. See `e2e/README.md`. `npx tsx tour.ts` screenshots every
  screen (phone, desktop, dark) and checks every control has an accessible name (what VoiceOver reads).
- Deploys and the post-deploy checks (anonymous denial via `infra/scripts/check-live.ts`, plus what only a live
  deploy or an iPhone can settle): `docs/deploy-runbook.md`.

## Layout (built so tickets can work in parallel)

- `shared/src/`: pure domain logic, one file per area (`profile.ts`: Avatar choices, Home zone check,
  new-Profile defaults, Display name/Avatar checks; `invite.ts`: token format, 7-day life, cap of 3, link;
  `signUp.ts`: username/password form rules; `log.ts`: Details rules, time rules, Day from instant + Log zone and back, Log sort keys; `calendar.ts`: heat levels, Monday-first month grid, month range, Day counts, monthly total + daily average; `friend.ts`: Friend code alphabet/format/parse, cap of 3, 10 sends a rolling day; `push.ts`: push prefs defaults/edits, the push-service endpoint allowlist + 10-device cap, the PushEvent the API hands the Notifier, push text (`eventPushPayload`, no Details) and tap links (`pushLinks`); `calendar.ts` also has `combinedColors`: a clashing Avatar color gets an alternate shade plus the emoji; `summary.ts`: when a Summary is due (`dueSummaryWeek`: Monday from 08:00 in the Home zone, for last Monday-Sunday), one person's numbers (`personWeek`), the Awards (`weekAwards`, thresholds as constants; Early bird/Night owl need 3+ nights, a default, and count a Log before 04:00 local as the night before, `NIGHT_ENDS_HOUR`); `push.ts` also has `summaryPushPayload` (no numbers) and `SCHEDULED_RUN`, the hourly schedule's event), each re-exported from `index.ts`. New pure logic (Day bucketing, heat levels,
  Summary math, Awards, Friend codes, limits) goes here with a vitest test.
- `schema/`: the GraphQL schema split per entity. `base.graphql` declares `Query` and `Mutation`; each
  `<entity>.graphql` adds fields with `extend type Query/Mutation { ... }`. `schema/compose.ts` merges them
  for AppSync and the e2e backend (a root type with no fields yet is left out) and owns `QUERY_DEPTH_LIMIT`
  and `queryDepth()`. Use `#` comments, not `"descriptions"` (a schema test enforces it).
- `api/src/`: `handler.ts` (caller = Cognito `sub`, then dispatch by field name), `table.ts` (key layout,
  document client seam), `resolvers/<entity>.ts` (one `ResolverModule` per entity, merged in
  `resolvers/index.ts`). `resolvers/profile.ts` has `ensureProfile(ctx, zone)`, which later resolvers can
  call to get the caller's Profile (it also moves the Home zone with the device unless the Profile pinned one;
  `updateProfile` edits it; the first call also writes the Profile's directory entry `PROFILES` / `PROFILE#<sub>` in the
  same transaction, and `profileIds()` lists them, so the hourly run needs no Scan; Delete Profile deletes it). `resolvers/invite.ts`: Invites at `INVITE#<token>` / `INVITE`, held in 3 places per
  Profile (`INVITESLOT#1-3`, claimed in a transaction, so the cap holds under races). An Invite item exists only while
  a place holds it (re-using a place deletes the spent one, revoking deletes it; no `usedBy`), so `forgetInvitesOf` finds all. `preSignUp.ts`: the Cognito
  pre-sign-up trigger (its own Lambda): reads the Invite (unknown/spent gets the generic refusal), then asks Cognito
  whether the username is taken (`cognito.ts` `userExists`, AdminGetUser with the event's pool ID; seam `setUserLookup`),
  then spends the Invite with one conditional write, so a username clash never burns it (ticket 12). `resolvers/log.ts`: Logs at `LOG#<Day>#<instant>#<id>` (a month of one
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
  cleanup), and its mirror `RESPTO#<owner>#<logId>` in the author's partition (ticket 12), always written/deleted
  with it (also by `deleteLog`), so Delete Profile's `forgetResponsesOf` finds Reactions/Comments with ex-Friends
  both ways. Each change is one transaction: Log Update conditioned on `rv`, both pointers, and a ConditionCheck on
  the author's `FRIEND#<owner>` item. Comments are capped at 20 per author per Log (per author, so the cap never
  hints at others' Comments). Display names and Comments refuse control and invisible format characters
  (shared `text.ts`); waiting sent Friend requests are capped at 5 (`MAX_PENDING_SENT`).
  `resolvers/push.ts` (ticket 09): `pushPrefs` toggles on the Profile record (absent = Summary on, rest off),
  "Friend logged" as `notifyLogs` on my `FRIEND#<other>` item (so ending a Friendship unfollows), devices at
  `PUSH#<deviceId>`. `events.ts`: `emit(PushEvent)` after a write commits = async Lambda invoke of the Notifier
  (ids only; never fails the write; no `NOTIFIER_FUNCTION` = no-op). `notifier.ts`: its own Lambda (CJS for
  web-push): re-checks the Friendship/request, applies prefs, sends to every device, prunes 404/410;
  `runScheduled()` is the hourly run (only for the `SCHEDULED_RUN` event; anything else unknown is ignored): for each
  Profile in the directory that `dueSummaryWeek` says is due, `resolvers/summary.ts` builds the Summary (them + current
  Friends, each person's Logs on their own Days via `logItems`, names/Avatars snapshotted) and stores it at
  `SUMMARY#<weekStart>` with `attribute_not_exists`: that write is the claim, and only the winning run pushes (if
  the Profile's Summary push is on). The claim is one transaction that also writes `INSUMMARY#<owner>#<weekStart>`
  under every other person in it and checks nobody in it has a `DELETED` marker (refused: rebuilt without them).
  `summaries` (Query) reads only the caller's own, newest first (104 max). `vapid.ts` + `vapidKeysProvider.ts`: the VAPID
  key custom resource (SSM `/throne/vapid/*`, never overwritten).
  `resolvers/deleteProfile.ts` (ticket 11): `deleteProfile` puts the content-free `PROFILE#<sub>` / `DELETED` marker
  first (from then on `handler.ts` refuses every other call of that sub with `ProfileDeleted`), then the directory
  entry, `forgetFriendsOf` (friend.ts: code, requests, Friendships + Reactions/Comments both ways), `forgetInvitesOf`,
  `scrubFromSummaries` (their row + Awards out of others' stored Summaries via the INSUMMARY pointers) and
  `forgetOwnSummaries`, a sweep of the whole partition, the Cognito user (`cognito.ts`, AdminDeleteUser, `Ctx.username`
  from the token; seam `setUserDeleter`), then `ttl` on the marker (table TTL attribute `ttl`, epoch seconds, a day).
  Each step is safe to repeat; a stopped run is finished by calling it again (the test stops it after every write).
- `api/src/testing/`: `harness.ts` (call the real handler as Profiles `A`-`D` against the fake table; it also
  captures push events, `h.deliver()` runs the real Notifier on them with a fake push service, `h.takePushes()`) and
  `fakeDynamo.ts` (in-memory document client: conditional writes, all-or-nothing transactions, and it
  refuses un-aliased attribute names and unused placeholders). It also stands in for IAM: the harness (and
  `e2e/backend.ts`) runs each Lambda inside `asLambda(name, ...)`, and any DynamoDB action (each one inside a
  transaction too) not listed for that Lambda in `api/src/dynamoAccess.ts` fails with AccessDeniedException.
- `infra/lib/`: `stacks.ts` (AppStack: table, Cognito, AppSync + Lambda, budget), `hosting.ts` (CertStack,
  WebStack: S3 + CloudFront with the CSP from `csp.ts`), `ci.ts` (CiStack: the GitHub OIDC deploy role),
  `config.ts` (zone/account from context or env), `app.ts` (wires them; Cert/Web/Ci only with hosting
  config). An AppSync resolver is created for every Query/Mutation field in the composed schema, so a new
  field needs only its schema line and its resolver. Table actions per Lambda come from `api/src/dynamoAccess.ts`
  (`grantTable`); `infra/test/iam.test.ts` asserts the grants equal that list and that each listed action really
  appears in that Lambda's esbuild bundle (nothing unused granted). The API Lambda gets Get/Put/Update/Delete/Query/ConditionCheckItem on the
  table, `lambda:InvokeFunction` on the Notifier and `cognito-idp:AdminDeleteUser` on this pool only (env `USER_POOL_ID`;
  no cycle, the pool's trigger is the separate pre-sign-up Lambda), no SSM (asserted in `infra/test/stacks.test.ts`). The
  Notifier gets Get/Query/Delete/Put/ConditionCheckItem on the table (Put + ConditionCheck only for the Summary claim) and `ssm:GetParameter`
  on the two VAPID parameters; its async invokes are never retried. An EventBridge Scheduler schedule (`NotifierHourly`,
  cron minute 0 UTC, retryAttempts 0, input `SCHEDULED_RUN`) invokes it through a role that may only invoke it. `config.json` gets `vapidPublicKey` from the VapidKeys resource.
- `web/src/`: `auth.ts` (Cognito JSON API: password, passkeys, refresh), `config.ts` (runtime `/config.json`),
  `api/gql.ts` (one call; `NetworkError` for anything retryable), `api/<entity>.ts` (GraphQL calls),
  `route.ts` (paths `/`, `/calendar` (also `?who=<sub>&day=<Day>` from a push), `/friends`, `/settings`, `/summary`, `/invite#<token>`; `useSearch`), `views/` (`Login`, `Home`, `Join` = Invite landing
  page, `Settings`, `AvatarPicker`, styles in `views/profile.css`; `views/log/`: the Log button + Undo toast, recent list, `LogEditor` details sheet; `views/calendar/`: `Calendar` (the Avatar row: Me, each Friend, Everyone; shown once there's a Friend), `MonthCalendar` (one person's heat month, or the combined grid with a count per person in Avatar colors from shared `combinedColors`), `monthLogs.ts` (`useMonthLogs`: my Logs from the outbox store via `refreshLogs`/`useLogs`, so pending ones show; a Friend's via `friendLogs`, never cached; one range query per person), `MonthGrid` (cell content from a `day()` callback), `DaySheet` (one group per person; only my Logs editable; Reactions/Comments under each Log via `log/Responses.tsx`, online only, and a Day marker when there are some), `refresh.ts` (focus + pull-to-refresh)). `views/summary/`: `SummaryCard` (one Summary; `compact` for Home), `SummaryScreen` (`/summary`, where the Summary
  push lands: latest in full, then past ones newest first) and `LatestSummaryCard` (under the Log list on Home);
  online only, `api/summary.ts` with the `SUMMARY` selection in `api/selections.ts`. `views/friends/`: `FriendsPanel` (Friend code, Add a Friend, requests, Friends list with an inline end-Friendship confirmation; online only, not in the outbox). Home has three tabs: `/` Log, `/calendar` Calendar, `/friends` Friends. `sync/`: the offline outbox for Logs (`outbox.ts` pure queue: in order, folds edits/deletes into a create still on the device, drops refused writes; `pending.ts` pure: server copy + queue = what shows, refusal messages; `logs.ts` glue: localStorage per username, retry every 20 s, flush on open/online/focus/visible; `profileCache.ts`: last Profile so Home opens offline). `sw/sw.ts` + `src/swShell.ts`: the hand-rolled service worker built by
  `vite.config.ts`; it also shows pushes and opens their link (`src/deepLink.ts`: `notificationFor`, `clickPlan`,
  the `navigate` message App.tsx follows; no imports, the worker build takes plain modules). Push glue:
  `notifications.ts` (enable inside the click handler, disable, sign-out `releaseThisDevice`), pure `push.ts`,
  `pushDevice.ts`, `timeout.ts` (from HoneyDo); `views/Notifications.tsx` is the Settings section. Delete Profile:
  Settings' last card (type "delete", shared `isDeleteConfirmed`), `account.ts` (`deleteMyProfile`; also registered with
  `gql.ts onProfileDeleted`, so any `ProfileDeleted` answer finishes a stopped deletion), pure `forgetProfileHere`
  (`forgetProfile.ts`) over the per-Profile keys in `storageKeys.ts`, then sign-out and a notice on Login. Light/dark follow the phone (`prefers-color-scheme` in `styles.css`). Icons:
  `web/brand/icon.svg` is the source for the PNGs in `web/public/`.
- `e2e/`: Playwright against an in-process fake backend (`backend.ts`: the real handler on the fake table,
  fake Cognito, AppSync's depth cap, `setServerClock`), launcher `app.ts`, helpers `lib.ts`, checks per area
  (`smoke.ts`, `log.ts`, `invites.ts`, `calendar.ts`, `offline.ts`, `friends.ts`, `friendsCalendar.ts`, `reactions.ts`, `push.ts`, `summary.ts` (`runSchedule(at)` in `backend.ts` runs the real Notifier's hourly run), `deleteProfile.ts`
  (fake Cognito's `deletedUsers` can't sign in); `open(u, { serviceWorkers: true, fakePush: true })` gives a stand-in push service); fake Cognito `SignUp` runs the real pre-sign-up trigger.
  The app is served with the deployed CSP (`infra/lib/csp.ts`); any CSP violation fails the run.

## Gotchas that will bite you

- **Identity is the Cognito `sub`** (`Ctx.sub`). Never read a Profile ID for the caller from arguments.
  Partitions are `PROFILE#<sub>`; the Profile record is `PROFILE#<sub>` / `PROFILE`.
- **Alias every attribute name** in every DynamoDB expression (`#status`, `#pk`, ...). The fake throws on a
  bare name or an unused `#name`/`:value`; live DynamoDB would throw on reserved words.
- **`QUERY_DEPTH_LIMIT` is the deepest real selection** (`me > avatar > emoji` and
  `myLogs > reactions > author` = 3 now; the Log selection lives in `web/src/api/selections.ts` so the test can
  import it). A ticket that sends a deeper one raises it and updates the pinned test in
  `infra/test/stacks.test.ts`; e2e refuses deeper queries. `infra/test/webQueries.test.ts` reads every GraphQL
  operation in `web/src` (selections must be plain string constants), validates each against the schema, checks
  the deepest equals the cap, and that every root field is used by the app.
- **Never write a Log item without the `rv` condition** (`sameResponses`/`unchangedSince` in `resolvers/log.ts`):
  a blind Put or Delete would wipe a Reaction or Comment that landed after the read (or leave its pointer).
  The only exceptions, each commented where it happens: `createLog`'s Put (the `LOGID#` `attribute_not_exists` in
  the same transaction guards it: a new Log has nothing on it yet), `updateLog`'s Put to the new SK when the
  Log moves (the Delete of the old item in the same transaction carries the `rv` condition), and Delete
  Profile's `sweep()` (the DELETED marker is down and no Friendship is left, so nothing can land).
- **The handler reads env at import time**: tests and e2e import it through `api/src/testing/harness.ts` /
  `e2e/backend.ts`, which set the env first. Never import it statically in a test.
- **Self sign-up is on only because of the Invite pre-sign-up trigger** (`api/src/preSignUp.ts`); never remove
  or weaken the trigger while self sign-up is on (one test in `infra/test/stacks.test.ts` asserts both). The
  trigger gets only `TABLE_NAME`, GetItem + UpdateItem on the table, and AdminGetUser on this pool in a separate
  `PreSignUpUserLookup` policy (a pool ID in its env, or the grant in its default policy, would be a circular dependency).
  Visitors can't call the API, so the Invite landing page only learns a link is spent when sign-up is refused.
  It checks the form before calling SignUp; the trigger's "username taken" and "try again" answers leave the Invite
  open (`web/src/auth.ts` keeps the form for those). Whether Cognito checks a taken username before or after the
  trigger is undocumented; `docs/deploy-runbook.md` step 9 checks it live.
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
- **Delete Profile must keep finding everything**: an item that holds a Profile's data or names them outside their own
  partition needs a pointer in their partition (like `RESPTO#`/`RESPFROM#`, `INSUMMARY#`, `INVITESLOT#`) and a step in
  `resolvers/deleteProfile.ts`; add it to the seed in `api/src/deleteProfile.test.ts`, which fails on any leftover
  naming them. Never store a username on someone else's item. New per-Profile localStorage keys go in
  `web/src/storageKeys.ts` and `forgetProfileHere`.
- **A new DynamoDB action goes in `api/src/dynamoAccess.ts`** for the Lambda that uses it (a transaction's
  ConditionCheck needs `ConditionCheckItem`); the fake refuses it until then, and infra grants exactly the list.
- **Reads that gate access are strongly consistent** (`ConsistentRead: true` in friend.ts `get()` and handler.ts
  `refuseDeleted`): an eventually consistent read could let an ex-Friend read Logs just after the Friendship ended.
- **Sign out forgets this Profile's copy** of Logs and Profile on the device (`forgetOnSignOut`); only unsent
  outbox writes stay.
- **Passkeys**: the relying party is `APP_DOMAIN` (`throne.ashershores.com`), so passkeys only work there,
  and changing it orphans every passkey.
