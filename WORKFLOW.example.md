---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: replace-with-linear-project-slug
  team_key:
  required_labels: []
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
  root: ./symphony_workspaces
  repo_path: .
  projects_root:
  repo_routes: {}
  base_branch: main

hooks:
  after_create:
  before_run:
  after_run:
  before_remove:
  timeout_ms: 60000

agent:
  backend: codex
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 300000
  rate_limit_probe_interval_ms: 15000

cursor:
  command: agent acp
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  # api_key: $CURSOR_API_KEY   # optional; default auth is agent login

codex:
  command: codex app-server --listen stdio://
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  model: auto

cursor:
  command: agent acp
  turn_timeout_ms: 3600000
  read_timeout_ms: 0

pull_request:
  backend: github
  graphite:
    fallback: fail

# Optional: open/update PRs as a GitHub App while Codex still runs locally.
github:
  pr_identity:
    kind: github_app
    app_slug: anmho-symphony
    token_command: symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'
    author_name: anmho Symphony
    author_email: 3862765+anmho-symphony[bot]@users.noreply.github.com
---
You are implementing Linear issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
State: {{ issue.state }}

Description:
{{ issue.description }}

Work in the current Git worktree. Make the smallest correct implementation, run relevant verification, and leave a clear handoff in Linear.
