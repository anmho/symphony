# Symphony

<p>
  <img src="./assets/brand/symphony-logo.svg" alt="Symphony logo" width="360">
</p>

[GitHub: anmho/symphony](https://github.com/anmho/symphony) · [npm: @anmho/symphony](https://www.npmjs.com/package/@anmho/symphony)

Local TypeScript Symphony runner for Linear-driven Codex app-server work orchestration.

This repo is a runnable TypeScript implementation of a Symphony-style harness:

- Linear supplies work.
- A single local runner owns in-memory scheduling, retries, and rate-limit parking.
- Git worktrees isolate each issue.
- Local `codex app-server` performs the implementation work inside each worktree.
- `WORKFLOW.md` owns repo-specific policy, hooks, and the agent prompt.

The default posture is high-trust local execution. Symphony is intended for repos and machines where unattended Codex work is acceptable.

## Docs

- [Symphony smoke](docs/symphony-smoke.md)
- [Release process](docs/release.md)
- [Logo design note](docs/brand/logo-design-note.md)
- [Stitch design system](.stitch/DESIGN.md) (project `16155015830023786079`)
- [Linear issue templates for Symphony dispatch](templates/README.md)
- [Symphony agent skill](https://github.com/anmho/skills/tree/main/skills/symphony)

## Requirements

- Node 22+
- Bun
- Codex CLI with `codex app-server`
- Linear API key

## Quick Start

Install dependencies:

```sh
bun install
```

Create a workflow file:

```sh
cp WORKFLOW.example.md WORKFLOW.md
```

This repo also includes a real root `WORKFLOW.md` for ANM team execution. It polls ANM tickets, but only dispatches issues explicitly labeled with both `symphony` and a configured `repo:<key>` route label.

Set your local environment, or put these values in `~/.config/symphony/config.json`:

```sh
export LINEAR_API_KEY=lin_api_...
export PROJECTS_ROOT=/Users/andrewho/repos/projects
```

Example user config:

```json
{
  "workflow": "/Users/andrewho/repos/projects/symphony/WORKFLOW.md",
  "env": {
    "PROJECTS_ROOT": "/Users/andrewho/repos/projects"
  },
  "secrets": {
    "LINEAR_API_KEY": {
      "command": "vault kv get -mount=secret -field=api_key prod/providers/linear"
    }
  }
}
```

User config lives under `~/.config/symphony` because it is machine-local configuration. The repo `.symphony/` directory is reserved for runtime workspaces and state.

Validate the workflow config:

```sh
bun run validate-config -- --workflow WORKFLOW.md
```

Install the `symphony` command globally:

```sh
bun run install:global
```

Install the Symphony agent skill from the canonical `anmho/skills` repo:

```sh
npx skills add anmho/skills --skill symphony --global --agent '*' -y
```

The skill is intentionally not vendored in this repo. The canonical source is
[`anmho/skills/skills/symphony`](https://github.com/anmho/skills/tree/main/skills/symphony);
the installer places it into the supported agent skill directories, including
`~/.agents/skills/symphony`.

Start the runner:

```sh
symphony start --workflow WORKFLOW.md
```

Check workflow status:

```sh
symphony status
```

Monitor agents in a k9s-style terminal UI:

```sh
symphony watch
```

`symphony watch` reads the same local status endpoint as `symphony status`, but presents agents as a continuously refreshed resource table. It supports `j/k` or arrow navigation, `:` command mode, `/` filtering, `?` help, `d` describe, `l` logs, `s` steer, `r` retry/resume selected, `ctrl-r` refresh, and `q` quit. The watch UI expands to fill the terminal width and height (k9s-style flex columns and dynamic log viewport).

### macOS menu bar monitor

Native **Swift/SwiftUI** app (not Electron) — lightweight menu bar popover with clickable Linear ticket links.

**Install the latest packaged release:**

```sh
curl -fsSL https://github.com/anmho/symphony/releases/latest/download/install.sh | bash
open -a Symphony
```

The installer places the app at `/Applications/Symphony.app`. The app is menu
bar only, so it will not appear in the Dock after onboarding.

**Install from source for local development:**

```sh
cd macos/SymphonyMenuBar
./install-local.sh
open -a Symphony
```

Or download a `.dmg` from [GitHub Releases](https://github.com/anmho/symphony/releases) (`menubar-v*` tags).

See [macos/SymphonyMenuBar/README.md](macos/SymphonyMenuBar/README.md) for build, Homebrew cask, and settings.

Follow an agent's public work stream from the CLI:

```sh
symphony logs ANM-123 --follow
symphony logs --all --follow
```

The work stream includes public assistant message deltas, command/tool lifecycle events, runner events, errors, and rate-limit notices. It does not expose hidden chain-of-thought; reasoning appears only when Codex emits an explicit public summary.

Queue guidance for the next turn on an issue:

```sh
symphony steer ANM-123 "focus on the keyboard regression before touching tests"
```

If Codex becomes available before a reported reset time, force a probe immediately:

```sh
symphony resume
```

Create a Linear ticket for Symphony dispatch using the agent-brief preset (labels `symphony`, `repo:<key>`, `needs-triage`):

```sh
# once per team: install the Linear issue template preset
symphony ticket template install --workflow WORKFLOW.md

# whenever WORKFLOW.md gains repo_routes entries, create missing repo:<key> labels
symphony labels sync --workflow WORKFLOW.md

symphony ticket create \
  --workflow WORKFLOW.md \
  --title "create-svc: ensure service destroy cleans up Grafana dashboards" \
  --repo create-svc \
  --context "Destroy already calls gcx resources delete when ./grafana exists." \
  --problem "Generated grafana manifests are not valid gcx resources manifests."
```

Use `--description-file path/to/body.md` to supply a fully grilled brief. Without section flags or a description file, Symphony fills the bundled `templates/symphony-issue.md` with `_TBD during triage/grill._` placeholders.

Linear also supports team issue templates in the UI. `symphony ticket template install` creates the same structure via the Linear API so new issues can reuse the preset.

## PR Handoff Backend

Symphony defaults to the existing GitHub PR handoff flow:

```yaml
pull_request:
  backend: github
```

For stacked PR work, opt into the Graphite CLI backend in `WORKFLOW.md`:

```yaml
pull_request:
  backend: graphite
  graphite:
    fallback: fail # or github
```

Graphite setup is local to each repository:

```sh
brew install withgraphite/tap/graphite
gt auth
gt init --trunk main
```

In Graphite mode, Symphony adds PR handoff instructions to each agent prompt. The worker must verify Graphite with `gt --version`, `gt log --stack --no-interactive`, and `gt submit --dry-run --stack --no-interactive --no-edit --no-ai`, submit with `gt submit --stack --no-interactive --no-edit --no-ai`, and then verify the GitHub PR metadata with `gh pr view --json url,baseRefName,headRefName,body`. Handoff is not complete unless the PR head matches the Symphony branch, the PR base matches the expected parent stack branch, and the PR body still contains the Linear Ticket link.

If `fallback: fail`, a missing or uninitialized Graphite setup is a clear blocker and the worker should leave a Linear handoff explaining it. If `fallback: github`, the worker may use the normal GitHub PR flow and note the fallback in Linear.

Recommended Graphite Inbox filter for Symphony PRs:

```text
author:@me (title:ANM- OR branch:symphony/)
```

Stop it:

```sh
symphony stop
```

## Runtime Model

`Orchestrator` reloads `WORKFLOW.md`, polls one Linear project, reconciles active runs, and dispatches issue workers up to `agent.max_concurrent_agents` defaulting to `5`.

Each issue worker prepares a Git worktree, runs hooks, starts or resumes a Codex app-server thread, and loops while the Linear issue remains active. When Codex reports a rate limit, the runner pauses new Codex launches until the reset time in the current process.

Runtime state is intentionally in-memory to match the OpenAI Symphony spec. Restart recovery is tracker/filesystem-driven: active Linear issues and existing worktrees determine what gets picked back up.

`symphony start` launches a normal detached user process and writes pid/log files under `~/.symphony`. It does not install a LaunchAgent or auto-start on login.

`symphony status`, `symphony watch`, and `symphony logs` expose the runner's observability surface: active issue runs, retry queue, Codex thread and turn IDs, app-server PIDs, event cursors, per-issue work-log paths, rate-limit parking, and config reload errors. Daemon process logs remain available under `~/.symphony/symphony-<port>.log`.

Rate-limit handling is intentionally different from ordinary failure retry. Symphony parks new launches until Codex's reported reset time, but also probes parked runs every `agent.rate_limit_probe_interval_ms` with per-issue jitter so work can resume if access returns earlier than the reported reset. The default probe interval is 15 seconds.

The committed ANM workflow stores issue worktrees under `.symphony/workspaces/<repo-key>/<issue-id>`. Per-issue public work streams are stored as JSONL under `.symphony/events/`, and queued steering state is stored under `.symphony/state/`. The `.symphony/` directory is ignored and used for local runtime state, not as the canonical workflow config.

## Safety Notes

- V1 does not destructively reset existing worktrees.
- Terminal issues run `before_remove` and remove their managed worktree.
- Runner comments in Linear are limited to operational breadcrumbs; Codex remains responsible for PR links and implementation handoff.
- The default Codex approval policy is `never`, so use this only in trusted environments.

## Validation

```sh
bun run validate
```
