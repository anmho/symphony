---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: ANM
  required_labels:
    - symphony
  repo_label_prefix: "repo:"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Canceled
    - Cancelled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  root: ./.symphony/workspaces
  repo_path: .
  projects_root: $PROJECTS_ROOT
  base_branch: main
  repo_routes:
    symphony: symphony
    x: x
    auth: auth
    agent: agent
    terraform: terraform
    create-svc: create-svc
    create-app-saas: create-app-saas
    create-app-consumer: create-app-consumer
    linear-ticket-sidepanel: linear-ticket-sidepanel

hooks:
  after_create:
  before_run:
  after_run:
  before_remove:
  timeout_ms: 60000

agent:
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server --listen stdio://
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  model:
---
You are Symphony working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
State: {{ issue.state }}
Labels: {{ issue.labels | join: ", " }}

Description:
{{ issue.description }}

Work only in the current Git worktree. Treat the Linear issue as the product spec, but verify the repo before changing code. Make the smallest correct implementation that satisfies the issue.

Expected workflow:
1. Inspect the repo instructions and relevant code before editing.
2. Keep changes scoped to the issue and preserve unrelated user work.
3. Run the most relevant tests, typechecks, builds, linters, or smoke checks available for the touched repo.
4. Commit the finished work on the Symphony-created branch.
5. Push the branch and open or update a GitHub pull request.
6. Leave a Linear handoff comment with the PR link, verification performed, and any remaining blocker.

If the issue requires human-only console work, missing product decisions, unavailable secrets, or an unsafe repo boundary, stop early and comment the blocker in Linear instead of guessing.
