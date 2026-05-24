# Linear issue templates for Symphony

Symphony dispatches issues from Linear that carry:

- `symphony`
- `repo:<key>` (must match a key in `WORKFLOW.md` → `workspace.repo_routes`)
- `needs-triage` until triaged to `ready-for-agent`

## Team presets (ANM)

Two issue templates are installed on the **ANM** team in Linear:

| Template | Linear name | Use when |
| --- | --- | --- |
| Standard | **Symphony agent brief** | Most AFK agent work (matches ANM-276, ANM-279, ANM-280, ANM-281) |
| Grilled | **Symphony grilled brief** | Work with locked design decisions from triage (matches ANM-284) |

**Symphony agent brief** is the ANM team default for new issues (members and non-members). `linear issue create --team ANM` pre-fills that body automatically and applies labels **`symphony`** and **`needs-triage`**. You still need to add **`repo:<key>`** (for example `repo:create-svc`) before moving to `ready-for-agent`.

Create issues in Linear with **New issue** (default template applies) or **Templates → Symphony grilled brief** when design is already locked, then add the repo route label before moving to `ready-for-agent`.

## Create from CLI

Standard brief (ANM default template applies body + `symphony`, `needs-triage` labels):

```bash
linear issue create \
  --team ANM \
  --title "my-repo: short imperative title" \
  --label repo:create-svc
```

Grilled brief via CLI (bypasses Linear template; pass all labels explicitly):

```bash
linear issue create \
  --team ANM \
  --title "my-repo: short imperative title" \
  --description-file templates/linear-symphony-grilled-issue.md \
  --label symphony \
  --label needs-triage \
  --label repo:create-svc \
  --no-use-default-template
```

In the Linear UI, pick **Templates → Symphony grilled brief** to get the body plus `symphony` and `needs-triage`; add **`repo:<key>`** before triage completes.

## Body shapes

**Standard** (`linear-symphony-issue.md`):

- Goal
- Current Problem (optional — delete if N/A)
- Scope
- Acceptance Criteria

**Grilled** (`linear-symphony-grilled-issue.md`):

- Context
- Design decisions (locked)
- Problem
- What to build
- Acceptance criteria
- Out of scope
- References

## Re-install templates

Templates are Linear team resources. Source markdown lives in this directory. To recreate after edits:

```bash
bun run templates:sync-linear
```

(Template IDs are stored in `templates/linear-templates.json`.)
