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
