---
name: symphony
description: >-
  Create and triage Linear issues for Symphony AFK dispatch, manage ANM issue
  templates and labels, and operate the Symphony runner (WORKFLOW.md, start,
  watch, logs, steer). Use when working with Symphony, Linear tickets for AFK
  agents, repo route labels, needs-triage or ready-for-agent, grilled briefs,
  or the anmho/symphony repository.
---

# Symphony

Symphony is the local Linear → Codex orchestrator for ANM. It **polls** Linear; it does **not** create tickets. Your job when using this skill is to file well-formed issues and keep labels/state correct so dispatch works.

**Canonical repo:** `anmho/symphony` (checkout at `$PROJECTS_ROOT/symphony` or equivalent).

## Dispatch requirements

An issue is picked up only when **all** of the following hold:

| Requirement | Detail |
| --- | --- |
| Label `symphony` | Required by `WORKFLOW.md` → `tracker.required_labels` |
| Label `repo:<key>` | Must match a key under `workspace.repo_routes` in `WORKFLOW.md` |
| Active state | One of `Todo`, `In Progress` (not terminal) |
| Triage complete | Remove `needs-triage`; use `ready-for-agent` when spec is locked |

`repo:<key>` is **never** baked into Linear templates — always add it per issue.

Read current routes from `WORKFLOW.md` before creating tickets.

## Create issues

### Preferred: Linear CLI (ANM default template)

**Symphony agent brief** is the ANM team default. New issues get the standard body plus labels `symphony` and `needs-triage`. Add only the repo route:

```bash
linear issue create \
  --team ANM \
  --title "<repo-key>: short imperative title" \
  --label repo:create-svc
```

Title convention: `<repo-key>: …` matching the route (e.g. `create-svc: ensure destroy cleans up Grafana`).

### Grilled brief (design already locked)

**Linear UI:** Templates → **Symphony grilled brief** → add `repo:<key>`.

**CLI** (bypasses template; pass all labels):

```bash
linear issue create \
  --team ANM \
  --title "<repo-key>: short imperative title" \
  --description-file templates/linear-symphony-grilled-issue.md \
  --label symphony \
  --label needs-triage \
  --label repo:create-svc \
  --no-use-default-template
```

Use grilled format after `/grill-me` or triage has locked decisions.

### Symphony CLI (programmatic)

From the symphony repo:

```bash
symphony ticket create \
  --workflow WORKFLOW.md \
  --title "create-svc: short imperative title" \
  --repo create-svc \
  --context "Background…" \
  --problem "What's broken…"
```

Or `--description-file path/to/body.md` for a full brief. Applies `symphony`, `repo:<key>`, and `needs-triage` automatically.

## Issue body shapes

Source markdown: `templates/` in this repo.

**Standard** (`linear-symphony-issue.md`) — most AFK work:

- Goal
- Current Problem (delete section if N/A)
- Scope
- Acceptance Criteria

**Grilled** (`linear-symphony-grilled-issue.md`) — post-triage / post-grill:

- Context
- Design decisions (locked)
- Problem
- What to build
- Acceptance criteria
- Out of scope
- References

Fill every section before moving to `ready-for-agent`. Delete empty placeholder bullets.

## Triage → dispatch

1. Issue enters with `needs-triage` (+ `symphony`, + `repo:<key>`).
2. Explore codebase; run `/grill-me` if design is ambiguous.
3. Rewrite the issue body using the appropriate template (standard or grilled).
4. Swap labels: remove `needs-triage`, add `ready-for-agent`.
5. Confirm `repo:<key>` matches the repo that will be edited.

Pair with the **triage** skill for role/state workflow. Symphony dispatch assumes the issue body *is* the spec.

## Template maintenance

Templates are Linear team resources synced from this repo:

```bash
bun run templates:sync-linear
```

- Catalog: `templates/linear-templates.json`
- Docs: `templates/README.md`
- Pre-applied labels on both templates: `symphony`, `needs-triage`

After editing `templates/linear-symphony-*.md`, run sync to push to Linear.

## Operate the runner

Config: `~/.config/symphony/config.json` or env (`LINEAR_API_KEY`, `PROJECTS_ROOT`).

```bash
symphony validate-config --workflow WORKFLOW.md
symphony start --workflow WORKFLOW.md
symphony status
symphony watch          # k9s-style UI
symphony logs ANM-123 --follow
symphony steer ANM-123 "focus on X before Y"
symphony resume         # probe rate limits early
symphony stop
```

Worktrees: `.symphony/workspaces/<repo-key>/<issue-id>`. Event logs: `.symphony/events/`.

## Request Codex PR Review

Use manual review requests instead of a background auto-review job. For a Symphony issue in `In Review`, request a Codex GitHub PR review from the CLI:

```bash
symphony review request ANM-123 --workflow WORKFLOW.md
```

This posts `@codex review` on the linked GitHub PR and writes a Linear comment so Symphony state shows that AI review was requested. If the PR URL is not present in the Linear handoff yet, pass it explicitly:

```bash
symphony review request ANM-123 \
  --workflow WORKFLOW.md \
  --pr https://github.com/anmho/symphony/pull/41
```

In the macOS menu bar app, use the PR row context menu action **Request Codex Review** for the same flow.

## Agent execution expectations

When Symphony (or you simulating an AFK run) works an issue:

1. Work only in the issue worktree for the routed repo.
2. Smallest correct change that meets acceptance criteria.
3. Run relevant tests/checks for that repo.
4. Commit, push, open/update PR.
5. Linear comment with PR link, verification, blockers.

Stop early and comment blockers for human-only console work, missing secrets, or unsafe boundaries.

## Checklist before marking ready-for-agent

```
- [ ] Title uses <repo-key>: prefix
- [ ] Label repo:<key> present and key exists in WORKFLOW.md repo_routes
- [ ] Label symphony present
- [ ] needs-triage removed; ready-for-agent applied
- [ ] Body complete (standard or grilled template)
- [ ] Acceptance criteria are verifiable
- [ ] Out of scope / references filled (grilled) or N/A sections removed (standard)
```

## Install this skill

```bash
npx skills add anmho/skills --skill symphony --global -y
```

`npx skills add` symlinks into agent skill directories by default (use `--copy` to materialize files).

## Related skills

- **triage** — state roles (`needs-triage` → `ready-for-agent`)
- **grill-me** — lock design decisions before grilled brief
- **to-issues** — break plans into vertical-slice tickets (then triage each)

## Additional resources

- Template IDs, label IDs, API snippets: [reference.md](reference.md)
