# Release

`@anmho/symphony` npm releases are workflow-driven. Do not publish a tagged release from a local machine during the normal release path.

## npm package publishing

The package is published by the GitHub Actions workflow at [`.github/workflows/publish.yml`](../.github/workflows/publish.yml).

Normal release path:

1. Update `package.json` to the intended version.
2. Merge the release commit to `main`.
3. Push a release tag named `v<package-version>`, for example `v0.1.3`.
4. Let the `Publish` workflow validate, build, verify the tag matches `package.json`, check whether the version already exists on npm, and publish if it is missing.

The workflow publishes with npm trusted publishing. npm automatically adds provenance for trusted-publisher publishes from this public GitHub repository:

```sh
npm publish --access public --tag "$NPM_DIST_TAG"
```

The workflow intentionally does not use `NODE_AUTH_TOKEN` for publishing. npm authorizes the publish through GitHub Actions OIDC and the package's trusted-publisher configuration.

## npm trusted publisher configuration

Configure this on npmjs.com for the existing `@anmho/symphony` package:

- Package: `@anmho/symphony`
- Trusted publisher provider: GitHub Actions
- GitHub organization or user: `anmho`
- GitHub repository: `symphony`
- Workflow filename: `publish.yml`
- Workflow path in this repo: `.github/workflows/publish.yml`
- `package.json` repository URL: `git+https://github.com/anmho/symphony.git`

The release tag trigger is `v*`. For tag-triggered releases, the version after the leading `v` must exactly match `package.json`; otherwise the workflow exits before publishing.

## Recovery

If a tag-triggered publish fails because npm-side trusted-publisher settings are missing or wrong, fix the npm package settings first. Then rerun the failed GitHub Actions workflow:

```sh
gh run rerun <run-id>
```

Do not recover by running local `npm publish` after a release tag. The publish workflow checks npm before publishing, so rerunning it after a partial or recovered release skips the publish step when that exact package version is already available.

Local manual publishing is only for emergency recovery when GitHub Actions or npm trusted publishing cannot be restored quickly. If that path is used, document the reason and return the package to workflow-only publishing before the next release.
