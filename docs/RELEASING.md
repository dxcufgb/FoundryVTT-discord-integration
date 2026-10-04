# Releasing

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) when a GitHub Release is **published**. The workflow runs the tests, stamps the version from the tag into `package.json`, installs production dependencies and attaches:

- `foundryvtt-discord-integration-<version>-linux.tar.gz` — bot + dependencies + `deploy/linux` (systemd)
- `foundryvtt-discord-integration-<version>-windows.zip` — bot + dependencies + `deploy/windows` (Task Scheduler)
- `SHA256SUMS.txt`

The bundles contain no native code, so one build serves both platforms.

## Procedure

1. Make sure `main` is green (the **CI** workflow runs the tests on Linux and Windows, Node 20 and 22).
2. Add a section for the new version to [`CHANGELOG.md`](../CHANGELOG.md) and merge it via a pull request (`main` is protected: one approving review, no force pushes).
3. On GitHub: **Releases → Draft a new release**.
   - *Choose a tag*: type the new tag, `vX.Y.Z` (semantic versioning: patch for fixes, minor for new commands/features, major for breaking changes such as changed `.env` variables or state format), and let GitHub create it from `main`.
   - *Title*: the same `vX.Y.Z`.
   - *Description*: paste the changelog section (or use *Generate release notes*).
4. **Publish release**. Within a couple of minutes the *Release bot* workflow attaches the bundles. Check the Actions tab if they are missing.

From the command line with the [GitHub CLI](https://cli.github.com):

```
gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes.md>
```

## Versioning notes

- `package.json` in the repository stays at the current release version and is updated by the workflow for the bundle, so a tag is the single source of truth for a release's version.
- Bumping `package.json` in the repository to match after a release is nice but not required.
- Pre-releases: tick *Set as a pre-release* on GitHub; the workflow builds them the same way, and the `/releases/latest` link keeps pointing at the last full release.

## Repository setup

This repository follows the same rules as the other `FoundryVTT-…` repositories:

- Public, MIT licence, issues/projects/wiki enabled.
- Pull requests are **squash merged** and the branch is deleted on merge.
- Ruleset **Protect main** on the default branch ([`.github/ruleset-protect-main.json`](../.github/ruleset-protect-main.json)): no deletion, no force pushes, changes via pull request with one approving review, stale reviews dismissed on push, repository admins may bypass for pull requests.

[`scripts/setup-repo.sh`](../scripts/setup-repo.sh) applies all of that with the GitHub CLI (it is what was used to create the repository and the `v1.0.0` release) and can be re-run safely to re-apply the settings.
