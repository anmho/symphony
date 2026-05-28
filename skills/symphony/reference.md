# Symphony reference

## Linear template IDs (ANM)

From `templates/linear-templates.json`:

| Template | Linear ID |
| --- | --- |
| Symphony agent brief (team default) | `e29d0217-dd21-4259-b535-c955e98adee8` |
| Symphony grilled brief | `292be30c-0588-4ca2-8ed9-994062e72977` |

Team: ANM (`68f73eea-6903-4663-9a31-56c18e93b4cb`)

## Label IDs (workspace)

| Label | ID |
| --- | --- |
| symphony | `86e8444f-7ea0-4b93-9289-0c2619951c27` |
| needs-triage | `0306895b-c9f0-4536-82a2-885d371020ca` |

Repo route labels follow `repo:<key>` (team-scoped). Verify with:

```bash
linear api 'query { issueLabels(filter: { name: { startsWith: "repo:" } }, first: 50) { nodes { name id } } }'
```

## Set team default template (API)

```bash
linear api 'mutation TeamUpdate($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success } }' \
  --variables-json '{"id":"68f73eea-6903-4663-9a31-56c18e93b4cb","input":{"defaultTemplateForMembersId":"e29d0217-dd21-4259-b535-c955e98adee8","defaultTemplateForNonMembersId":"e29d0217-dd21-4259-b535-c955e98adee8"}}'
```

## symphony ticket create flags

```
--workflow WORKFLOW.md   (required)
--title                  (required)
--repo <key>             (required; adds repo:<key>)
--description-file       full markdown body
--context / --problem / --design-decisions / …  section overrides for bundled template
--triage-label           default needs-triage
--state                  default Todo
```

## WORKFLOW.md frontmatter (tracker)

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: ANM
  required_labels:
    - symphony
  repo_label_prefix: "repo:"
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed, Canceled, Cancelled, Duplicate]

agent:
  backend: codex   # or cursor

# Cursor: local @cursor/sdk uses your Cursor login — no api_key in WORKFLOW required.
# Optional model alias (see Cursor.models.list()): composer-latest, composer-2.5, etc.
# cursor:
#   model: composer-latest

# Optional CI / explicit API-key auth (same pattern as LINEAR_API_KEY):
#   alias cursor-api-key='vault kv get -mount=secret -field=api_key prod/providers/cursor'
# cursor:
#   api_key: $CURSOR_API_KEY
```

Resolve `$CURSOR_API_KEY` only when `WORKFLOW.md` sets `cursor.api_key: $CURSOR_API_KEY`, via `~/.config/symphony/config.json` env or Vault `secrets` (like `LINEAR_API_KEY`). Otherwise the SDK uses the local Cursor install session (`agent login` / IDE).

## Missing repo route label

On `symphony validate-config` or start, Symphony warns when `WORKFLOW.md` lists a `repo_routes` key with no matching Linear label. Run this before filing issues for newly configured repos:

```bash
symphony labels sync --workflow WORKFLOW.md
```
