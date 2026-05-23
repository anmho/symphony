# Agent Notes

Default to Bun for local development in this repository.

- Use `bun install` for dependencies.
- Use `bun run validate` for typecheck plus tests.
- Use `bun run build` before publishing or changing CLI entrypoints.
- Use `symphony run` for foreground local testing and `symphony start` / `symphony stop` for the background runner.
- Do not add a LaunchAgent, LaunchDaemon, or other auto-start mechanism unless explicitly requested.
- Keep npm publishing through GitHub Actions trusted publishing; manual publishing is only for bootstrapping or recovery.
